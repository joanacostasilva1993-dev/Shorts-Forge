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
 * REAL word timestamps, then `retimeSpec()` (pure, existing), then the real
 * video render — per-segment Hyperframes clips + FFmpeg assembly via
 * `@shorts-forge/video` — then the automatic QC stage (`qc.ts`): the job
 * only reaches `done` (with `outputPath` pointing at
 * `outputs/<jobId>/final.mp4`) when every quality check passes; a failed
 * QC moves it to `qc-failed` with pt-PT reasons, and `/download` refuses
 * to serve it. `retryQc()` re-runs only the QC stage.
 *
 * The video step is injectable (`OrchestratorDeps.renderVideo`) so tests
 * can substitute a fast double; the default is the real implementation.
 * A render failure fails the job honestly (no fake MP4, ever).
 *
 * Known simplification (documented, Phase 3 candidate): for `kind: 'audio'`
 * inputs, Phase B re-synthesizes the narration with TTS instead of reusing
 * the original recording. The transcription drives Phase A (timings included);
 * reusing the recorded voice in Phase B is future work.
 */

import type {
  PipelineInput,
  PlatformPresetId,
  ShortClipStrategy,
  Spec,
  TranscriptionResult,
  TtsResult,
  VideoFormat,
} from '@shorts-forge/shared';
import { renderJobVideo, resolveBrollForSegments, resolvePreset } from '@shorts-forge/video';
import {
  generateSpec as generateSpecViaLlm,
  validateSpecJson,
  type GenerateSpecOptions,
  type SpecRouterLike,
} from './spec.js';
import { retimeSpec } from './retime.js';
import { getCachedTranscript, putCachedTranscript } from './cache.js';
import { ServiceClients } from './pythonBridge.js';
import { ApiError, Job, JobEvent, JobStore, type JobTtsChoice } from './jobs.js';
import type { ServiceManager } from './services.js';
import { getLanguageEntry, resolveTtsForJob } from './voiceCatalog.js';
import { jobOutputsDir, outputsRoot } from './outputs.js';
import {
  QC_CAPTION_FILENAME,
  formatQcFailurePt,
  formatQcWarningsPt,
  runQc,
  writeCaptionsSrt,
  writeQcReport,
  type QcReport,
} from './qc.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The video step of Phase B: renders a re-timed spec to the final MP4.
 * Returns the absolute final path. Injectable so tests can substitute a
 * fast double; the default is the real `@shorts-forge/video` pipeline
 * (per-segment Hyperframes clips + FFmpeg assembly).
 */
export type RenderVideoFn = (
  spec: Spec,
  opts: {
    jobId: string;
    format: VideoFormat;
    /** Platform preset; when given it implies the format and drives canvas/safe-area/loudness. */
    preset?: PlatformPresetId;
    outDir: string;
    onProgress: (done: number, total: number, message: string) => void;
  },
) => Promise<string>;

/** Default RenderVideoFn: the real per-segment render + assembly. */
export async function defaultRenderVideo(
  spec: Spec,
  opts: {
    jobId: string;
    format: VideoFormat;
    preset?: PlatformPresetId;
    outDir: string;
    onProgress: (done: number, total: number, message: string) => void;
  },
): Promise<string> {
  const renderOpts: Parameters<typeof renderJobVideo>[1] = {
    outDir: opts.outDir,
    format: opts.format,
    onProgress: opts.onProgress,
  };
  if (opts.preset !== undefined) renderOpts.preset = opts.preset;
  return renderJobVideo(spec, renderOpts);
}

/** The Pipeline interface (ARCHITECTURE.md §4.3). */
export interface Pipeline {
  createJob(
    input: PipelineInput,
    opts: {
      format: VideoFormat;
      language: string;
      ttsChoice?: JobTtsChoice;
      /** Platform preset (TikTok, YouTube Shorts, …). When given it wins over `format`. */
      preset?: PlatformPresetId;
      /**
       * Per-project short-clip strategy for B-roll ('loop' = smooth loop
       * with crossfade, the default; 'freeze' = hold the last frame).
       * Absent → the B-roll resolver defaults to 'loop'.
       */
      shortClipStrategy?: ShortClipStrategy;
    },
  ): Promise<Job>;
  /** Fase A: audio → transcribe (+cache) → LLM → strict validate → store. */
  generateSpec(jobId: string): Promise<Spec>;
  /** Utilizador edita/aprova: validate (strict) + store. */
  approveSpec(jobId: string, spec: Spec): Promise<Job>;
  /** Fase B: kicks off async; returns the job with status `rendering`. */
  render(jobId: string): Promise<Job>;
  /**
   * Re-runs ONLY the QC stage against the existing `final.mp4` of a
   * `qc-failed` job (e.g. the video file was fixed externally, or a QC
   * check misfired). Kicks off async; returns the job with status `qc`.
   */
  retryQc(jobId: string): Promise<Job>;
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
  /**
   * Phase B video step. Defaults to the real `@shorts-forge/video`
   * render (`defaultRenderVideo`); tests inject a fast double.
   */
  renderVideo?: RenderVideoFn;
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
  private readonly renderVideo: RenderVideoFn;
  /** Guards against concurrent generateSpec/render on the same job. */
  private readonly inFlight = new Set<string>();

  constructor(deps: OrchestratorDeps) {
    this.router = deps.router;
    this.services = deps.services;
    this.serviceManager = deps.serviceManager;
    this.store = deps.store ?? new JobStore();
    this.transcriptCacheDir = deps.transcriptCacheDir;
    this.renderVideo = deps.renderVideo ?? defaultRenderVideo;
  }

  /** Exposed for the server/SSE layer (shares the same store). */
  get jobStore(): JobStore {
    return this.store;
  }

  async createJob(
    input: PipelineInput,
    opts: {
      format: VideoFormat;
      language: string;
      ttsChoice?: JobTtsChoice;
      preset?: PlatformPresetId;
      shortClipStrategy?: ShortClipStrategy;
    },
  ): Promise<Job> {
    validateInput(input);
    const requestedFormat = validateFormat(opts.format);
    const language = validateLanguage(opts.language);
    const shortClipStrategy = validateShortClipStrategy(opts.shortClipStrategy);
    // Precedence (docs/platforms.md): an explicit preset wins over
    // `format` and implies its own format. Without a preset, the format
    // maps to that aspect's default preset (9:16 → YouTube Shorts,
    // 16:9 → YouTube long-form).
    let preset;
    try {
      preset = resolvePreset(opts.preset ?? null, requestedFormat);
    } catch (err) {
      throw new ApiError('invalid_input', 400, errMsg(err));
    }
    return this.store.create(
      input,
      preset.format,
      language,
      opts.ttsChoice,
      preset.id,
      shortClipStrategy,
    );
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
    if (job.status !== 'awaiting-approval' && job.status !== 'qc-failed') {
      throw new ApiError(
        'invalid_state',
        409,
        `Só é possível renderizar um job com a Spec aprovada ou que tenha chumbado no QC (estado atual: "${job.status}").`,
      );
    }
    this.inFlight.add(jobId);
    // Re-render from qc-failed clears the previous failure state and the
    // (rejected) video, so /download can never serve it afterwards.
    const started = this.store.update(jobId, {
      status: 'rendering',
      progress: 0,
      error: undefined,
      outputPath: undefined,
    });
    this.store.emit(jobId, 'rendering', 'A iniciar a Fase B: TTS por segmento…');
    // Phase B runs detached; completion/failure arrives via events.
    void this.runPhaseB(jobId).finally(() => this.inFlight.delete(jobId));
    return started;
  }

  async retryQc(jobId: string): Promise<Job> {
    const job = this.store.get(jobId);
    if (this.inFlight.has(jobId)) {
      throw new ApiError(
        'already_running',
        409,
        'Este job já tem uma operação em curso — aguarda que termine.',
      );
    }
    if (job.status !== 'qc-failed') {
      throw new ApiError(
        'invalid_state',
        409,
        `Só é possível repetir o QC de um job em "qc-failed" (estado atual: "${job.status}").`,
      );
    }
    if (!job.spec) {
      throw new ApiError(
        'spec_missing',
        409,
        'O job perdeu a Spec — já não é possível repetir o QC.',
      );
    }
    if (!job.outputPath || !existsSync(job.outputPath)) {
      throw new ApiError(
        'video_not_ready',
        409,
        'O vídeo final desapareceu do disco — volta a correr o render.',
      );
    }
    this.inFlight.add(jobId);
    const started = this.store.update(jobId, {
      status: 'qc',
      error: undefined,
      progress: 0.95,
    });
    this.store.emit(jobId, 'qc', 'A repetir o controlo de qualidade…');
    // QC re-run is detached; the outcome arrives via events.
    void this.runQcStage(jobId).finally(() => this.inFlight.delete(jobId));
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
      if (event.type === 'done' || event.type === 'failed' || event.type === 'qc-failed') {
        terminal = true;
      }
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
      // The job language travels as a transcription hint (faster-whisper
      // `language` param) — it biases detection, it never forces a wrong
      // language: unknown tags fall back to auto-detect server-side.
      result = await this.services.transcribe(audioPath, job.language);
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
      const job = this.store.get(jobId);
      const spec = job.spec;
      if (!spec) throw new Error('a Spec desapareceu antes da Fase B');

      // Language-aware voice resolution: explicit UI choice > env > catalog
      // default for the job's language (see voiceCatalog.ts).
      const ttsConfig = resolveTtsForJob({
        language: job.language,
        engine: job.ttsChoice?.engine,
        voice: job.ttsChoice?.voice,
      });
      this.store.emit(
        jobId,
        'progress',
        `Voz da narração: ${ttsConfig.voice} (${ttsConfig.provider}, idioma ${job.language}).`,
      );

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
      this.store.update(jobId, { spec: retimed, progress: 0.8 });
      this.store.emit(
        jobId,
        'progress',
        'Spec re-temporizada com os tempos reais do áudio — sem drift.',
      );

      // ── B-roll resolution (real): semantic matching per segment with
      // fallback cascade (Pexels → Pixabay → Ken Burns → template).
      // A segment never ends without visuals; failures fall through
      // silently inside the resolver (logged, never fatal).
      this.store.emit(jobId, 'progress', 'A escolher o B-roll de cada segmento…');
      await resolveBrollForSegments(retimed.segments, {
        format: job.format,
        cacheDir: join(outputsRoot(), 'cache', 'broll'),
        projectDir: jobOutputsDir(jobId),
        shortClipStrategy: job.shortClipStrategy,
        log: (message) => this.store.emit(jobId, 'progress', message),
      });

      // ── Video render (real): per-segment Hyperframes clips + FFmpeg ──
      // Progress events stream to the UI over SSE via the store's event
      // bus. Any failure here fails the job honestly — never a fake MP4.
      this.store.emit(jobId, 'rendering', 'A renderizar os segmentos do vídeo…');
      const outDir = jobOutputsDir(jobId);
      const finalPath = await this.renderVideo(retimed, {
        jobId,
        format: job.format,
        preset: job.preset,
        outDir,
        onProgress: (done, totalSegs, message) => {
          const progress = 0.8 + (0.2 * done) / Math.max(1, totalSegs);
          this.store.update(jobId, { progress });
          this.store.emit(jobId, 'progress', message);
        },
      });

      // ── Captions sidecar: the QC stage checks it against the spec ──
      const captionPath = join(outDir, QC_CAPTION_FILENAME);
      writeCaptionsSrt(retimed, captionPath);

      // ── QC stage (automatic): analyse the final MP4 before `done` ──
      this.store.update(jobId, { outputPath: finalPath });
      await this.runQcStage(jobId);
    } catch (err) {
      const api =
        err instanceof ApiError
          ? err
          : new ApiError('render_failed', 500, `Falha na Fase B: ${errMsg(err)}`);
      this.store.fail(jobId, api.message);
      this.store.emit(jobId, 'failed', api.message);
    }
  }

  /**
   * Runs the automatic QC stage for a job whose `outputPath` and `spec`
   * are already set. Writes `outputs/<jobId>/qc-report.json`, then moves
   * the job to `done` (all checks passed) or `qc-failed` (pt-PT reasons
   * in `job.error`). Never throws for content failures — only for
   * missing inputs (which become an honest `failed` via the caller).
   */
  private async runQcStage(jobId: string): Promise<void> {
    const job = this.store.get(jobId);
    const spec = job.spec;
    const videoPath = job.outputPath;
    if (!spec) throw new Error('a Spec desapareceu antes do QC');
    if (!videoPath) throw new Error('o vídeo final desapareceu antes do QC');

    this.store.update(jobId, { status: 'qc', progress: 0.95 });
    this.store.emit(jobId, 'qc', 'A verificar a qualidade do vídeo final…');

    // A config de TTS é determinística para o job — resolve-se de novo para
    // a rastreabilidade do relatório ("este render usou que voz?").
    const ttsConfig = resolveTtsForJob({
      language: job.language,
      engine: job.ttsChoice?.engine,
      voice: job.ttsChoice?.voice,
    });

    const outDir = jobOutputsDir(jobId);
    const report: QcReport = await runQc({
      jobId,
      videoPath,
      spec,
      captionPath: join(outDir, QC_CAPTION_FILENAME),
      tts: { provider: ttsConfig.provider, voice: ttsConfig.voice, rate: ttsConfig.rate },
    });
    writeQcReport(outDir, report);

    if (report.passed) {
      this.store.update(jobId, { progress: 1, status: 'done' });
      const warnings = formatQcWarningsPt(report);
      this.store.emit(
        jobId,
        'done',
        warnings
          ? `Vídeo final pronto — passou no controlo de qualidade. ${warnings}`
          : 'Vídeo final pronto — passou no controlo de qualidade.',
      );
    } else {
      const reasons = formatQcFailurePt(report);
      this.store.update(jobId, { progress: 0.95, status: 'qc-failed', error: reasons });
      this.store.emit(jobId, 'qc-failed', reasons);
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
  if (typeof language !== 'string' || language.trim().length === 0) {
    throw new ApiError('invalid_input', 400, 'O campo "language" tem de ser uma string não vazia.');
  }
  // Throws ApiError(400, unsupported_language) for unknown tags — the
  // catalog (packages/tts/voices.catalog.json) is the authority.
  return getLanguageEntry(language).tag;
}

/**
 * Validates the per-project short-clip strategy (ARCHITECTURE.md §7:
 * 'loop' = smooth loop with crossfade is the default; 'freeze' holds
 * the last frame). Absent → undefined (the B-roll resolver defaults to
 * 'loop'); anything else → 400.
 */
function validateShortClipStrategy(value: unknown): ShortClipStrategy | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'loop' || value === 'freeze') return value;
  throw new ApiError(
    'invalid_input',
    400,
    'O campo "shortClipStrategy" tem de ser "loop" ou "freeze".',
  );
}

function toPhaseAFailure(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError('phase_a_failed', 500, `Falha na Fase A: ${errMsg(err)}`);
}
