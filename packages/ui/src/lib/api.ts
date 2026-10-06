/**
 * Typed API client for the shorts-forge pipeline backend.
 *
 * Contract: ARCHITECTURE.md §8 (UI ↔ backend).
 * Base: http://localhost:3000/api — jobs + SSE + preview/download.
 *
 * The backend is real (packages/pipeline, :3000): createJob, generateSpec,
 * approveSpec, renderJob, subscribeJobEvents, getPreviewUrl and
 * getDownloadUrl all hit the frozen REST contract. getPreviewUrl() and
 * getDownloadUrl() return plain URLs for <video> players / anchors —
 * preview serves an inline low-res MP4, download serves the final MP4 as
 * an attachment.
 */

import type {
  ChatRequest,
  ChatResult,
  PipelineInput,
  PlatformPresetId,
  Spec,
  VideoFormat,
} from '@shorts-forge/shared';

export type JobStatus =
  | 'spec-draft'
  | 'awaiting-approval'
  | 'rendering'
  | 'done'
  | 'failed';

export interface Job {
  id: string;
  status: JobStatus;
  input: PipelineInput;
  spec?: Spec;
  progress: number;
  error?: string;
}

export type JobEventType =
  | 'spec-draft'
  | 'awaiting-approval'
  | 'rendering'
  | 'done'
  | 'failed'
  | 'progress';

export interface JobEvent {
  type: JobEventType;
  job: Job;
}

export interface ProviderStatus {
  name: string;
  reachable: boolean;
  keyless: boolean;
  quotaHint?: string;
}

export interface CreateJobOptions {
  format: VideoFormat;
  language: string;
  /**
   * Platform preset (tiktok, youtube-shorts, youtube-long,
   * instagram-reels). Sent to POST /api/jobs; the server gives it
   * precedence over `format` and resolves canvas, caption safe areas
   * and loudness from it.
   */
  preset?: PlatformPresetId;
  /** Explicit per-job TTS choice (StepVoice); sent through to Phase B. */
  tts?: { engine?: string; voice?: string };
}

const API_BASE = 'http://localhost:3000/api';

function backendUnavailable(): Error {
  return new Error('backend indisponível — Fase 2');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch {
    // No backend listening yet (Fase 5 skeleton).
    throw backendUnavailable();
  }
  if (!res.ok) {
    let message = `Pedido falhou (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) message = body.error.message;
    } catch {
      /* keep fallback */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/** POST /api/jobs — cria um job de pipeline. */
export async function createJob(
  input: PipelineInput,
  opts: CreateJobOptions,
): Promise<Job> {
  const body: Record<string, unknown> = {
    input,
    format: opts.format,
    language: opts.language,
  };
  if (opts.preset) body['preset'] = opts.preset;
  if (opts.tts) body['tts'] = opts.tts;
  const { job } = await request<{ job: Job }>('/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return job;
}

/** GET /api/jobs/:id — lê o estado atual de um job. */
export async function getJob(id: string): Promise<Job> {
  const { job } = await request<{ job: Job }>(`/jobs/${encodeURIComponent(id)}`);
  return job;
}

/** POST /api/jobs/:id/spec — Fase A: gera a Spec do job. */
export async function generateSpec(id: string): Promise<Spec> {
  const { spec } = await request<{ spec: Spec }>(
    `/jobs/${encodeURIComponent(id)}/spec`,
    { method: 'POST' },
  );
  return spec;
}

/** PUT /api/jobs/:id/spec — utilizador edita/aprova a Spec. */
export async function approveSpec(id: string, spec: Spec): Promise<Job> {
  const { job } = await request<{ job: Job }>(
    `/jobs/${encodeURIComponent(id)}/spec`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec }),
    },
  );
  return job;
}

/** POST /api/jobs/:id/render — Fase B: render final. */
export async function renderJob(id: string): Promise<Job> {
  const { job } = await request<{ job: Job }>(
    `/jobs/${encodeURIComponent(id)}/render`,
    { method: 'POST' },
  );
  return job;
}

/**
 * GET /api/jobs/:id/events — subscreve os eventos SSE do job.
 * Devolve uma função de cleanup. Falhas de ligação são reportadas
 * via `onError` como 'backend indisponível — Fase 2'.
 */
export function subscribeJobEvents(
  id: string,
  onEvent: (event: JobEvent) => void,
  onError?: (err: Error) => void,
): () => void {
  const source = new EventSource(
    `${API_BASE}/jobs/${encodeURIComponent(id)}/events`,
  );
  const handler = (e: MessageEvent) => {
    try {
      onEvent(JSON.parse(e.data) as JobEvent);
    } catch {
      /* ignora mensagens malformadas */
    }
  };
  source.addEventListener('message', handler as EventListener);
  source.onerror = () => {
    source.close();
    onError?.(backendUnavailable());
  };
  return () => source.close();
}

/** GET /api/jobs/:id/preview — URL do MP4 de preview (baixa resolução). */
export function getPreviewUrl(id: string): string {
  return `${API_BASE}/jobs/${encodeURIComponent(id)}/preview`;
}

/** GET /api/jobs/:id/download — URL do MP4 final. */
export function getDownloadUrl(id: string): string {
  return `${API_BASE}/jobs/${encodeURIComponent(id)}/download`;
}

/** GET /api/llm/status — estado dos providers do llm-router. */
export async function getLlmStatus(): Promise<ProviderStatus[]> {
  const { providers } = await request<{ providers: ProviderStatus[] }>(
    '/llm/status',
  );
  return providers;
}

/** POST /api/llm/chat — chat manual/debug via llm-router. */
export async function llmChat(req: ChatRequest): Promise<ChatResult> {
  const result = await request<ChatResult>('/llm/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  return result;
}
