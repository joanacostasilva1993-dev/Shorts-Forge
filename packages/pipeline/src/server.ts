/**
 * Servidor HTTP da API REST do pipeline — o contrato congelado de
 * ARCHITECTURE.md §8, servido em `http://localhost:3000/api`.
 *
 * Sem frameworks: só `node:http`. Rotas:
 *
 *   POST   /api/jobs                 → 201 { job }
 *   POST   /api/jobs/:id/spec        → 200 { spec }   (Fase A; emite SSE)
 *   PUT    /api/jobs/:id/spec        → 200 { job }    (validar + guardar)
 *   POST   /api/jobs/:id/render      → 202 { job }    (Fase B, async)
 *   GET    /api/jobs/:id             → 200 { job }
 *   GET    /api/jobs/:id/events      → SSE (spec-draft, awaiting-approval,
 *                                      rendering, done, failed, progress)
 *   GET    /api/jobs/:id/download    → MP4 (quando existir; senão 404/409 honestos)
 *   GET    /api/jobs/:id/preview     → MP4 de preview, baixa resolução
 *                                      (render leve; 409 sem Spec aprovada)
 *   GET    /api/llm/status           → 200 { providers }
 *   POST   /api/llm/chat             → 200 ChatResult (passthrough debug)
 *
 * Erros: `{ error: { code, message } }`, `message` sempre em pt-PT.
 * Porta: `PIPELINE_API_PORT` (omissão 3000 — o contrato congelado).
 *
 * Arranque: `node dist/src/server.js` (ou `npm run serve` / `npm run dev`
 * dentro de `packages/pipeline`; `npm run dev:pipeline` na raiz).
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { ChatRequest, ChatResult } from '@shorts-forge/shared';
import { createRouter, loadConfigFromEnv } from '@shorts-forge/llm-router';
import { renderPreviewMp4 } from '@shorts-forge/video';
import { ApiError, type Job, type JobEvent } from './jobs.js';
import { ServiceClients } from './pythonBridge.js';
import { ServiceManager } from './services.js';
import { PipelineOrchestrator, type Pipeline } from './orchestrate.js';
import { getProviderStatuses, type ProviderStatus } from './llmStatus.js';
import { jobOutputsDir } from './outputs.js';

export interface ServerDeps {
  pipeline: Pipeline;
  /** Passthrough de chat para /api/llm/chat (debug). */
  chat: (req: ChatRequest) => Promise<ChatResult>;
  /** Backing de /api/llm/status. */
  llmStatus: () => Promise<ProviderStatus[]>;
  /** Called when the HTTP server closes (e.g. stop spawned services). */
  onClose?: () => void | Promise<void>;
  /**
   * Builds (or locates) the low-res preview MP4 for a job; returns its
   * absolute path. Defaults to the real light Hyperframes render, cached
   * per Spec hash. Tests inject a fast double.
   */
  buildPreview?: (job: Job) => Promise<string>;
}

export interface StartServerOptions {
  port?: number;
  host?: string;
}

export interface StartedServer {
  server: Server;
  pipeline: PipelineOrchestrator;
  serviceManager: ServiceManager;
  port: number;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SSE_KEEPALIVE_MS = 20_000;

// ── Small HTTP helpers ─────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent || res.destroyed) return;
  if (err instanceof ApiError) {
    sendJson(res, err.httpStatus, { error: { code: err.code, message: err.message } });
    return;
  }
  console.error('[pipeline] erro interno:', err instanceof Error ? err.stack ?? err.message : err);
  sendJson(res, 500, {
    error: { code: 'internal_error', message: 'Erro interno do servidor.' },
  });
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, {
    error: { code: 'not_found', message: 'Rota desconhecida.' },
  });
}

function methodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, {
    error: { code: 'method_not_allowed', message: 'Método não suportado para esta rota.' },
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(
        'body_too_large',
        413,
        'Corpo do pedido demasiado grande (máximo 8 MB).',
      );
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError('invalid_json', 400, 'Corpo do pedido não é JSON válido.');
  }
}

function bodyField<T>(body: unknown, field: string): T {
  if (typeof body !== 'object' || body === null || !(field in body)) {
    throw new ApiError('bad_request', 400, `Falta o campo "${field}" no corpo do pedido.`);
  }
  return (body as Record<string, unknown>)[field] as T;
}

// ── Server ─────────────────────────────────────────────────────────

/** Builds the API server; the caller decides when to listen/close. */
export function createServer(deps: ServerDeps): Server {
  const { pipeline } = deps;

  const server = createHttpServer((req, res) => {
    // Permissive CORS for local development (the UI dev-server runs on :5173).
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    void handleRequest(req, res, deps).catch((err: unknown) => sendError(res, err));
  });

  server.on('close', () => {
    try {
      const r = deps.onClose?.();
      if (r && typeof (r as Promise<void>).catch === 'function') {
        void (r as Promise<void>).catch((err: unknown) =>
          console.error('[pipeline] erro ao encerrar serviços:', err),
        );
      }
    } catch (err) {
      console.error('[pipeline] erro ao encerrar serviços:', err);
    }
  });

  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter((p) => p.length > 0);
  if (parts[0] !== 'api') return notFound(res);

  const resource = parts[1];
  if (resource === 'jobs') {
    await handleJobs(req, res, deps, parts.slice(2));
    return;
  }
  if (resource === 'llm') {
    await handleLlm(req, res, deps, parts.slice(2));
    return;
  }
  return notFound(res);
}

async function handleJobs(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  parts: string[],
): Promise<void> {
  const { pipeline } = deps;
  const method = req.method ?? 'GET';

  // POST /api/jobs
  if (parts.length === 0) {
    if (method !== 'POST') return methodNotAllowed(res);
    const body = await readJsonBody(req);
    const input = bodyField(body, 'input');
    const b = (body ?? {}) as Record<string, unknown>;
    const format = b['format'] ?? '9:16';
    const language = b['language'] ?? 'pt-PT';
    const ttsRaw = b['tts'] as { engine?: unknown; voice?: unknown } | undefined;
    const ttsChoice:
      | { engine?: string | undefined; voice?: string | undefined }
      | undefined =
      ttsRaw && typeof ttsRaw === 'object'
        ? {
            ...(typeof ttsRaw.engine === 'string' ? { engine: ttsRaw.engine } : {}),
            ...(typeof ttsRaw.voice === 'string' ? { voice: ttsRaw.voice } : {}),
          }
        : undefined;
    try {
      const job = await pipeline.createJob(
        input as Parameters<Pipeline['createJob']>[0],
        ttsChoice
          ? { format: format as '9:16' | '16:9', language: language as string, ttsChoice }
          : { format: format as '9:16' | '16:9', language: language as string },
      );
      sendJson(res, 201, { job });
    } catch (err) {
      sendError(res, err);
    }
    return;
  }

  const id = decodeURIComponent(parts[0] ?? '');
  const sub = parts[1];

  // GET /api/jobs/:id
  if (parts.length === 1) {
    if (method !== 'GET') return methodNotAllowed(res);
    try {
      const job = await pipeline.getJob(id);
      sendJson(res, 200, { job });
    } catch (err) {
      sendError(res, err);
    }
    return;
  }

  if (sub === 'spec' && parts.length === 2) {
    if (method === 'POST') {
      // Fase A.
      try {
        const spec = await pipeline.generateSpec(id);
        sendJson(res, 200, { spec });
      } catch (err) {
        sendError(res, err);
      }
      return;
    }
    if (method === 'PUT') {
      // Utilizador edita/aprova.
      try {
        const body = await readJsonBody(req);
        const spec = bodyField(body, 'spec');
        const job = await pipeline.approveSpec(id, spec as Parameters<Pipeline['approveSpec']>[1]);
        sendJson(res, 200, { job });
      } catch (err) {
        sendError(res, err);
      }
      return;
    }
    return methodNotAllowed(res);
  }

  // POST /api/jobs/:id/render — Fase B (202, async).
  if (sub === 'render' && parts.length === 2) {
    if (method !== 'POST') return methodNotAllowed(res);
    try {
      const job = await pipeline.render(id);
      sendJson(res, 202, { job });
    } catch (err) {
      sendError(res, err);
    }
    return;
  }

  // GET /api/jobs/:id/events — SSE.
  if (sub === 'events' && parts.length === 2) {
    if (method !== 'GET') return methodNotAllowed(res);
    await handleSse(req, res, deps, id);
    return;
  }

  // GET /api/jobs/:id/download — MP4 final (quando existir).
  if (sub === 'download' && parts.length === 2) {
    if (method !== 'GET') return methodNotAllowed(res);
    await handleDownload(res, deps, id);
    return;
  }

  // GET /api/jobs/:id/preview — MP4 de preview, baixa resolução.
  if (sub === 'preview' && parts.length === 2) {
    if (method !== 'GET') return methodNotAllowed(res);
    await handlePreview(res, deps, id);
    return;
  }

  return notFound(res);
}

async function handleLlm(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  parts: string[],
): Promise<void> {
  const method = req.method ?? 'GET';
  const sub = parts[0];

  if (sub === 'status' && parts.length === 1) {
    if (method !== 'GET') return methodNotAllowed(res);
    const providers = await deps.llmStatus();
    sendJson(res, 200, { providers });
    return;
  }

  if (sub === 'chat' && parts.length === 1) {
    if (method !== 'POST') return methodNotAllowed(res);
    const body = await readJsonBody(req);
    const chatReq = body as ChatRequest;
    if (
      typeof chatReq !== 'object' ||
      chatReq === null ||
      !Array.isArray(chatReq.messages) ||
      chatReq.messages.length === 0
    ) {
      sendJson(res, 400, {
        error: {
          code: 'bad_request',
          message: 'O pedido de chat precisa de "messages" (array não vazio).',
        },
      });
      return;
    }
    try {
      const result = await deps.chat(chatReq);
      sendJson(res, 200, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 502, {
        error: {
          code: 'llm_failed',
          message: `Nenhum provider de LLM respondeu: ${message}`,
        },
      });
    }
    return;
  }

  return notFound(res);
}

/** SSE stream of a job's events. Unknown job → 404 JSON (not a stream). */
async function handleSse(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  id: string,
): Promise<void> {
  let job;
  try {
    job = await deps.pipeline.getJob(id);
  } catch (err) {
    sendError(res, err);
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event: JobEvent): void => {
    if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  send({ type: job.status, job });

  const keepAlive = setInterval(() => {
    if (!res.destroyed) res.write(': ping\n\n');
  }, SSE_KEEPALIVE_MS);
  keepAlive.unref();

  const iterator = deps.pipeline.specEvents(id)[Symbol.asyncIterator]();
  const abort = (): void => {
    void iterator.return?.(undefined);
  };
  req.on('close', abort);
  try {
    for (;;) {
      const { value, done } = await iterator.next();
      if (done || res.destroyed) break;
      send(value);
    }
  } finally {
    req.off('close', abort);
    clearInterval(keepAlive);
    await iterator.return?.(undefined);
    if (!res.destroyed) res.end();
  }
}

/** Serves the final MP4 when the job produced one; honest errors until then. */
async function handleDownload(
  res: ServerResponse,
  deps: ServerDeps,
  id: string,
): Promise<void> {
  let job;
  try {
    job = await deps.pipeline.getJob(id);
  } catch (err) {
    sendError(res, err);
    return;
  }
  if (job.status !== 'done') {
    sendJson(res, 409, {
      error: {
        code: 'job_not_finished',
        message: `O job ainda não terminou (estado atual: "${job.status}").`,
      },
    });
    return;
  }
  if (!job.outputPath || !existsSync(job.outputPath)) {
    sendJson(res, 409, {
      error: {
        code: 'video_not_ready',
        message:
          'O job terminou mas o ficheiro de vídeo não foi encontrado. ' +
          'Volta a correr o render ou verifica os logs do servidor.',
      },
    });
    return;
  }
  serveMp4(res, job.outputPath, true);
}

/**
 * Builds (when needed) and serves the low-res preview MP4.
 * 404 for unknown jobs; 409 when the job has no approved Spec yet.
 */
async function handlePreview(
  res: ServerResponse,
  deps: ServerDeps,
  id: string,
): Promise<void> {
  let job;
  try {
    job = await deps.pipeline.getJob(id);
  } catch (err) {
    sendError(res, err);
    return;
  }
  const build = deps.buildPreview ?? defaultBuildPreview;
  let previewPath: string;
  try {
    previewPath = await build(job);
  } catch (err) {
    sendError(res, err);
    return;
  }
  if (!existsSync(previewPath)) {
    sendJson(res, 500, {
      error: {
        code: 'preview_failed',
        message: 'A pré-visualização falhou — verifica os logs do servidor.',
      },
    });
    return;
  }
  serveMp4(res, previewPath, false);
}

/** Streams an MP4 file: attachment for downloads, inline for previews. */
function serveMp4(res: ServerResponse, filePath: string, attachment: boolean): void {
  const size = statSync(filePath).size;
  const headers: Record<string, string> = {
    'Content-Type': 'video/mp4',
    'Content-Length': String(size),
    'Accept-Ranges': 'bytes',
  };
  if (attachment) {
    headers['Content-Disposition'] = `attachment; filename="${basename(filePath)}"`;
  }
  res.writeHead(200, headers);
  const stream = createReadStream(filePath);
  stream.on('error', (err) => {
    console.error('[pipeline] erro a servir o MP4:', err);
    if (!res.destroyed) res.destroy();
  });
  stream.pipe(res);
}

/**
 * Default preview builder: a fast low-res Hyperframes render of the job's
 * Spec, cached under `outputs/<jobId>/preview.mp4` and regenerated only
 * when the Spec changes (sha256 sidecar).
 */
export async function defaultBuildPreview(job: Job): Promise<string> {
  const spec = job.spec;
  if (!spec) {
    throw new ApiError(
      'preview_not_ready',
      409,
      'O job ainda não tem uma Spec aprovada para pré-visualizar.',
    );
  }
  const outDir = jobOutputsDir(job.id);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'preview.mp4');
  const hashPath = `${outPath}.spechash`;
  const hash = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
  try {
    if (existsSync(outPath) && readFileSync(hashPath, 'utf8').trim() === hash) {
      return outPath;
    }
  } catch {
    // Cache miss or unreadable sidecar — render fresh.
  }
  await renderPreviewMp4(spec, outPath, {
    format: job.format,
    template: 'bold-social',
    tmpDir: join(outDir, '.tmp'),
  });
  writeFileSync(hashPath, hash, 'utf8');
  return outPath;
}

// ── Wiring (real dependencies) ─────────────────────────────────────

function resolvePort(optPort?: number): number {
  if (optPort !== undefined) return optPort;
  const raw = (process.env.PIPELINE_API_PORT ?? '').trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3000;
}

/** Builds the production dependency graph and starts listening. */
export function startServer(opts: StartServerOptions = {}): StartedServer {
  const router = createRouter(loadConfigFromEnv());
  const services = new ServiceClients();
  const serviceManager = new ServiceManager(services);
  const pipeline = new PipelineOrchestrator({ router, services, serviceManager });

  const server = createServer({
    pipeline,
    chat: (req) => router.chat(req),
    llmStatus: () => getProviderStatuses(),
    onClose: () => serviceManager.shutdown(),
  });

  const port = resolvePort(opts.port);
  const host = opts.host ?? '127.0.0.1';
  server.listen(port, host, () => {
    console.log(`[pipeline] API pronta em http://${host}:${port}/api`);
    console.log('[pipeline] Serviços Python: arranque preguiçoso (:8001 transcrição, :8002 TTS)');
  });

  let stopping = false;
  const graceful = (): void => {
    if (stopping) return;
    stopping = true;
    console.log('\n[pipeline] a encerrar…');
    void serviceManager
      .shutdown()
      .catch((err: unknown) => console.error('[pipeline] erro ao parar serviços:', err))
      .finally(() => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 5000).unref();
      });
  };
  process.on('SIGINT', graceful);
  process.on('SIGTERM', graceful);

  const close = async (): Promise<void> => {
    await serviceManager.shutdown();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return { server, pipeline, serviceManager, port, close };
}

// Direct execution: `node dist/src/server.js`.
const invokedAsMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  startServer();
}
