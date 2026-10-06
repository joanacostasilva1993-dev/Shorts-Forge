/**
 * Orquestração REAL do pipeline em duas fases (Fase 2).
 *
 * Implements the `Pipeline` interface from ARCHITECTURE.md §4.3:
 *
 *   createJob(input, opts) → Job            # cria o job (status: spec-draft)
 *   generateSpec(jobId)      → Spec          # FASE A (LLM; transcreve áudio primeiro)
 *   approveSpec(jobId, spec) → Job           # utilizador edita e aprova a Spec
 *   render(jobId)            → Job           # FASE B (TTS → re-temporização → [Fase 4])
 *   getJob(jobId)            → Job
 *   specEvents(jobId)         → AsyncIterable<JobEvent>  # para SSE
 *
 * `render()` kicks Phase B off asynchronously and returns the job immediately
 * (status `rendering`) — the REST layer answers 202 and the job completes via
 * events, exactly like the frozen contract requires.
 *
 * Phase B (this phase's scope): per-segment TTS via `ServiceClients` with
 * REAL word timestamps, then `retimeSpec()` (pure, existing). The video
 * assembly step belongs to Phase 4: it is explicitly marked in the job
 * events, and the job finishes `done` with `outputPath` unset — `/download`
 * answers 409 honestly until Phase 4 lands. Nothing here fakes an MP4.
 *
 * Known simplification (documented, Phase 3 candidate): for `kind: 'audio'`
 * inputs, Phase B re-synthesizes the narration with TTS instead of reusing
 * the original recording. The transcription drives Phase A (timings included);
 * reusing the recorded voice in Phase B is future work.
 */

import type {
  PipelineInput,
  Spec,
  TranscriptionResult,
  TtsResult,
  VideoFormat,
} from '@shorts-forge/shared';
import { detectHwAccel } from '@shorts-forge/video';
import {
  generateSpec as generateSpecViaLlm,
  validateSpecJson,
  type GenerateSpecOptions,
  type SpecRouterLike,
} from './spec.js';
import { retimeSpec } from './retime.js';
import { getCachedTranscript, putCachedTranscript } from './cache.js';
import { ServiceClients } from './pythonBridge.js';
import { ApiError, Job, JobEvent, JobStore } from './jobs.js';
import type { ServiceManager } from './services.js';
import { resolveTtsConfig } from './ttsConfig.js';

/** The Pipeline interface (ARCHITECTURE.md §4.3). */
export interface Pipeline {
  createJob(input: PipelineInput, opts: { format: VideoFormat; language: string }): Promise<Job>;
  /** Fase A: audio → transcribe (+cache) → LLM → strict validate → store. */
  generateSpec(jobId: string): Promise<Spec>;
  /** Utilizador edita/aprova: validate (strict) + store. */
  approveSpec(jobId: string, spec: Spec): Promise<Job>;
  /** Fase B: kicks off async; returns the job with status `rendering`. */
  render(jobId: string): Promise<Job>;
  getJob(jobId: string): Promise<Job>;
  /** Event stream for SSE. */
  specEvents(jobId: string): AsyncIterable<JobEvent>;
}

export interface OrchestratorDeps {
  /** LLM router (any object with `chatJson` — the real router or a test double). */
  router: SpecRouterLike;
  /** HTTP clients for the Python services. */
  services: ServiceClients;
  /** Lifecycle (lazy spawn / health / idle shutdown) for the Python services. */
  serviceManager: ServiceManager;
  /** In-memory store; a fresh one is created when omitted. */
  store?: JobStore;
  /** Transcript cache dir override (tests); defaults to the repo cache. */
  transcriptCacheDir?: string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const GENERATABLE = new Set(['spec-draft', 'awaiting-approval']);

export class PipelineOrchestrator implements Pipeline {
  private readonly router: SpecRouterLike;
  private readonly services: ServiceClients;
  private readonly serviceManager: ServiceManager;
  private readonly store: JobStore;
  private readonly transcriptCacheDir: string | undefined;
  /** Guards against concurrent generateSpec/render on the same job. */
  private readonly inFlight = new Set<string>();

  constructor(deps: OrchestratorDeps) {
    this.router = deps.router;
    this.services = deps.services;
    this.serviceManager = deps.serviceManager;
    this.store = deps.store ?? new JobStore();
    this.transcriptCacheDir = deps.transcriptCacheDir;
  }

  /** Exposed for the server/SSE layer (shares the same store). */
  get jobStore(): JobStore {
    return this.store;
  }

  async createJob(
    input: PipelineInput,
    opts: { format: VideoFormat; language: string },
  ): Promise<Job> {
    validateInput(input);
    const format = validateFormat(opts.format);
    const language = validateLanguage(opts.language);
    return this.store.create(input, format, language);
  }

  async generateSpec(jobId: string): Promise<Spec> {
    const job = this.store.get(jobId);
    if (this.inFlight.has(jobId)) {
      throw new ApiError(
        'already_running',
        409,
        'Este job já tem uma operação em curso — aguarda que termine.',
      );
    }
    if (!GENERATABLE.has(job.status)) {
      throw new ApiError(
        'invalid_state',
        409,
        `Não é possível gerar a Spec com o job em "${job.status}".`,
      );
    }
    this.inFlight.add(jobId);
    try {
      if (job.status === 'awaiting-approval') {
        // Regeneration discards the previous approval.
        this.store.update(jobId, { status: 'spec-draft' });
      }
      this.store.emit(jobId, 'spec-draft', 'A gerar a Spec com o LLM…');

      const transcript = await this.transcriptFor(job);
      const spec = await this.callLlm(job, transcript);

      this.store.update(jobId, { spec, status: 'awaiting-approval', progress: 0 });
      this.store.emit(jobId, 'awaiting-approval', 'Spec pronta — revê e aprova para continuar.');
      return spec;
    } catch (err) {
      const api = toPhaseAFailure(err);
      this.store.fail(jobId, api.message);
      this.store.emit(jobId, 'failed', api.message);
      throw api;
    } finally {
      this.inFlight.delete(jobId);
    }
  }

  async approveSpec(jobId: string, spec: Spec): Promise<Job> {
    const job = this.store.get(jobId);
    if (!GENERATABLE.has(job.status)) {
      throw new ApiError(
        'invalid_state',
        409,
        `Não é possível aprovar a Spec com o job em "${job.status}".`,
      );
    }
    let validated: Spec;
    try {
      validated = validateSpecJson(spec, { format: job.format, language: job.language });
    } catch (err) {
      // Validation failure is the user's edit to fix — don't fail the job.
      throw new ApiError('spec_invalid', 400, errMsg(err));
    }
    const updated = this.store.update(jobId, {
      spec: validated,
      status: 'awaiting-approval',
    });
    this.store.emit(jobId, 'awaiting-approval', 'Spec atualizada e aprovada.');
    return updated;
  }

  async render(jobId: string): Promise<Job> {
    const job = this.store.get(jobId);
    if (this.inFlight.has(jobId)) {
      throw new ApiError(
        'already_running',
        409,
        'Este job já tem uma operação em curso — aguarda que termine.',
      );
    }
    if (!job.spec) {
      throw new ApiError(
        'spec_missing',
        409,
        'Gera e aprova a Spec antes de renderizar (Fase A primeiro).',
      );
    }
    if (job.status !== 'awaiting-approval') {
      throw new ApiError(
        'invalid_state',
        409,
        `Só é possível renderizar um job com a Spec aprovada (estado atual: "${job.status}").`,
      );
    }
    this.inFlight.add(jobId);
    const started = this.store.update(jobId, { status: 'rendering', progress: 0 });
    this.store.emit(jobId, 'rendering', 'A iniciar a Fase B: TTS por segmento…');
    // Phase B runs detached; completion/failure arrives via events.
    void this.runPhaseB(jobId).finally(() => this.inFlight.delete(jobId));
    return started;
  }

  async getJob(jobId: string): Promise<Job> {
    return this.store.get(jobId);
  }

  async *specEvents(jobId: string): AsyncIterable<JobEvent> {
    // Throws ApiError(404) for unknown jobs — before any subscription.
    this.store.get(jobId);
    const queue: JobEvent[] = [];
    let wake: (() => void) | null = null;
    let terminal = false;
    const unsubscribe = this.store.subscribe(jobId, (event) => {
      queue.push(event);
      if (event.type === 'done' || event.type === 'failed') terminal = true;
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    });
    try {
      for (;;) {
        while (queue.length > 0) {
          yield queue.shift() as JobEvent;
        }
        if (terminal) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      unsubscribe();
    }
  }

  // ── Phase A helpers ──────────────────────────────────────────────

  /** Transcription for audio inputs (cache-first); undefined for topics. */
  private async transcriptFor(job: Job): Promise<TranscriptionResult | undefined> {
    if (job.input.kind !== 'audio') return undefined;
    const audioPath = job.input.audioPath;
    let cached: TranscriptionResult | null = null;
    try {
      cached = getCachedTranscript(audioPath, this.transcriptCacheDir);
    } catch (err) {
      // Unreadable audio file — fail loudly, in pt-PT (cache.ts already is).
      throw new ApiError('audio_unreadable', 400, errMsg(err));
    }
    if (cached) return cached;

    await this.ensureService('transcription');
    let result: TranscriptionResult;
    try {
      result = await this.services.transcribe(audioPath);
    } catch (err) {
      throw new ApiError('service_unavailable', 503, errMsg(err));
    }
    try {
      putCachedTranscript(audioPath, result, this.transcriptCacheDir);
    } catch (err) {
      // Cache write failure is non-fatal — the transcription itself worked.
      console.warn(`[pipeline] aviso: não foi possível guardar a transcrição em cache: ${errMsg(err)}`);
    }
    return result;
  }

  private async callLlm(job: Job, transcript: TranscriptionResult | undefined): Promise<Spec> {
    try {
      const genOpts: GenerateSpecOptions = { format: job.format, language: job.language };
      if (transcript) genOpts.transcript = transcript;
      return await generateSpecViaLlm(job.input, this.router, genOpts);
    } catch (err) {
      throw new ApiError(
        'llm_failed',
        502,
        `Falha na Fase A: nenhum provider de LLM conseguiu gerar a Spec. ${errMsg(err)} ` +
          `Verifica as chaves em .env (ou usa Ollama local / modo browser).`,
      );
    }
  }

  // ── Phase B ──────────────────────────────────────────────────────

  private async runPhaseB(jobId: string): Promise<void> {
    try {
      await this.ensureService('tts');
      const ttsConfig = resolveTtsConfig();

      const job = this.store.get(jobId);
      const spec = job.spec;
      if (!spec) throw new Error('a Spec desapareceu antes da Fase B');

      const ttsBySegment = new Map<string, TtsResult>();
      const total = spec.segments.length;
      for (let i = 0; i < total; i++) {
        const segment = spec.segments[i];
        if (!segment) continue;
        this.store.emit(
          jobId,
          'progress',
          `A gerar voz do segmento ${i + 1}/${total} (${segment.id})…`,
        );
        let tts: TtsResult;
        try {
          tts = await this.services.synthesize(
            segment.narration,
            ttsConfig.voice,
            ttsConfig.rate,
            ttsConfig.provider,
          );
        } catch (err) {
          throw new ApiError('service_unavailable', 503, errMsg(err));
        }
        ttsBySegment.set(segment.id, tts);
        const progress = 0.1 + (0.7 * (i + 1)) / total;
        this.store.update(jobId, { progress });
        this.store.emit(jobId, 'progress', `Voz do segmento ${i + 1}/${total} pronta.`);
      }

      // Re-time with REAL word timestamps — the heart of the architecture.
      const retimed = retimeSpec(spec, ttsBySegment);
      this.store.update(jobId, { spec: retimed, progress: 0.9 });
      this.store.emit(
        jobId,
        'progress',
        'Spec re-temporizada com os tempos reais do áudio — sem drift.',
      );

      // ── Video assembly: Phase 4 boundary (explicit stub) ──────────
      // packages/video's assemble() is an honest Phase 4 stub (it throws),
      // so this step only probes what's real today (FFmpeg availability)
      // and marks the boundary in the event stream. No MP4 is faked.
      const hwAccel = detectHwAccel();
      const stubNote =
        `Montagem de vídeo ainda não implementada (Fase 4) — FFmpeg detetado (${hwAccel}). ` +
        `A Spec re-temporizada e o áudio TTS de cada segmento estão prontos.`;
      this.store.update(jobId, { progress: 1, status: 'done' });
      this.store.emit(jobId, 'rendering', stubNote);
      this.store.emit(jobId, 'done', stubNote);
    } catch (err) {
      const api =
        err instanceof ApiError
          ? err
          : new ApiError('render_failed', 500, `Falha na Fase B: ${errMsg(err)}`);
      this.store.fail(jobId, api.message);
      this.store.emit(jobId, 'failed', api.message);
    }
  }

  private async ensureService(kind: 'transcription' | 'tts'): Promise<void> {
    try {
      if (kind === 'transcription') await this.serviceManager.ensureTranscription();
      else await this.serviceManager.ensureTts();
    } catch (err) {
      throw new ApiError('service_unavailable', 503, errMsg(err));
    }
  }
}

// ── Input validation (POST /api/jobs and friends) ───────────────────

function validateInput(input: unknown): asserts input is PipelineInput {
  if (typeof input !== 'object' || input === null) {
    throw new ApiError('invalid_input', 400, 'Falta o campo "input" no corpo do pedido.');
  }
  const kind = (input as { kind?: unknown }).kind;
  if (kind === 'topic') {
    const topic = (input as { topic?: unknown }).topic;
    if (typeof topic !== 'string' || topic.trim().length === 0) {
      throw new ApiError('invalid_input', 400, 'O campo "input.topic" tem de ser uma string não vazia.');
    }
    return;
  }
  if (kind === 'audio') {
    const audioPath = (input as { audioPath?: unknown }).audioPath;
    if (typeof audioPath !== 'string' || audioPath.trim().length === 0) {
      throw new ApiError(
        'invalid_input',
        400,
        'O campo "input.audioPath" tem de ser uma string não vazia.',
      );
    }
    return;
  }
  throw new ApiError(
    'invalid_input',
    400,
    'O campo "input.kind" tem de ser "topic" ou "audio".',
  );
}

function validateFormat(format: unknown): VideoFormat {
  if (format === '9:16' || format === '16:9') return format;
  throw new ApiError('invalid_input', 400, 'O campo "format" tem de ser "9:16" ou "16:9".');
}

function validateLanguage(language: unknown): string {
  if (typeof language === 'string' && language.trim().length > 0) return language.trim();
  throw new ApiError('invalid_input', 400, 'O campo "language" tem de ser uma string não vazia.');
}

function toPhaseAFailure(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError('phase_a_failed', 500, `Falha na Fase A: ${errMsg(err)}`);
}
