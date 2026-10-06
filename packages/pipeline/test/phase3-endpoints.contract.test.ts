/**
 * Testes de contrato da Fase 3 — endpoints preview/download e línguas.
 *
 * Verifica contra o que CORRE de verdade (servidor real, Pipeline fake
 * em memória — o comportamento HTTP, códigos de estado e formato de erro
 * é o que está sob teste, como em server.test.ts).
 *
 * Estado real em 2026-10-06:
 *  - GET /api/jobs/:id/download → 200 com o ficheiro real quando o job
 *    está `done` e `outputPath` aponta para um ficheiro em disco;
 *    404 (job desconhecido) / 409 (job_not_finished | video_not_ready)
 *    honestos nos restantes casos.
 *  - GET /api/jobs/:id/preview → 200 com o MP4 de baixa resolução quando
 *    o job tem Spec (a engenharia de render ligou o preview real:
 *    `renderPreviewMp4` com cache por hash da Spec); 404 para job
 *    desconhecido e 409 `preview_not_ready` sem Spec.
 *  - POST /api/jobs aceita os quatro idiomas da Fase 3 e guarda-os no job.
 *
 * Correr: npm test (tsc → node --test dist/test)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { PipelineInput, Spec } from '@shorts-forge/shared';
import { createServer } from '../src/server.js';
import { ApiError, JobStore, type Job, type JobEvent, type Pipeline } from '../src/index.js';

/** Pipeline fake mínimo, igual ao de server.test.ts (contrato, não lógica). */
function fakePipeline(): { pipeline: Pipeline; store: JobStore } {
  const store = new JobStore();
  const pipeline: Pipeline = {
    createJob: async (input, opts) => store.create(input, opts.format, opts.language),
    generateSpec: async (id) => {
      throw new Error(`generateSpec não usado neste contrato (job ${id})`);
    },
    approveSpec: async (id) => store.get(id),
    render: async (id) => {
      const updated = store.update(id, { status: 'rendering', progress: 0 });
      store.emit(id, 'rendering');
      return updated;
    },
    retryQc: async (id) => {
      throw new ApiError('not_supported', 501, `retryQc não usado neste contrato (job ${id})`);
    },
    getJob: async (id) => store.get(id),
    specEvents: async function* (id: string): AsyncIterable<JobEvent> {
      store.get(id);
      return;
    },
  };
  return { pipeline, store };
}

async function startTestServer(previewMp4: string): Promise<{ server: Server; base: string; store: JobStore; close: () => Promise<void> }> {
  const { pipeline, store } = fakePipeline();
  const server = createServer({
    pipeline,
    chat: async () => {
      throw new Error('chat não usado neste contrato');
    },
    llmStatus: async () => [],
    // Double rápido do preview: devolve um MP4 real quando o job tem Spec.
    buildPreview: async (job: Job) => {
      if (!job.spec) {
        throw new ApiError('preview_not_ready', 409, 'O job ainda não tem uma Spec aprovada.');
      }
      return previewMp4;
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    store,
    base: `http://127.0.0.1:${port}/api`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

let base = '';
let store: JobStore;
let closeServer: () => Promise<void>;
let scratchDir = '';
let previewMp4 = '';

/** MP4 real mínimo (1s) para os testes de preview. */
function makePreviewMp4(dir: string): string {
  const out = join(dir, 'preview.mp4');
  const res = spawnSync(
    'ffmpeg',
    [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=navy:s=360x640:d=1:r=30',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
      out,
    ],
    { timeout: 60_000, encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error('ffmpeg indisponível para o fixture de preview');
  return out;
}

async function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function getBytes(path: string): Promise<{ status: number; headers: Headers; bytes: Buffer }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
}

async function createJob(language: string): Promise<Job> {
  const input: PipelineInput = { kind: 'topic', topic: 'tema de teste' };
  const { status, json } = await post('/jobs', { input, format: '9:16', language });
  assert.equal(status, 201);
  return (json as { job: Job }).job;
}

before(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), 'shorts-forge-download-'));
  previewMp4 = makePreviewMp4(scratchDir);
  const started = await startTestServer(previewMp4);
  base = started.base;
  store = started.store;
  closeServer = started.close;
});

after(async () => {
  await closeServer();
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('download — contrato (Fase 3)', () => {
  it('happy path: job done + MP4 em disco → 200 video/mp4 com os bytes reais', async () => {
    const job = await createJob('pt-PT');
    const fakeMp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
    const outPath = join(scratchDir, 'final.mp4');
    writeFileSync(outPath, fakeMp4);
    store.update(job.id, { status: 'done', progress: 1, outputPath: outPath });

    const { status, headers, bytes } = await getBytes(`/jobs/${job.id}/download`);
    assert.equal(status, 200);
    assert.equal(headers.get('content-type'), 'video/mp4');
    assert.equal(headers.get('content-length'), String(fakeMp4.length));
    assert.match(headers.get('content-disposition') ?? '', /attachment; filename="final\.mp4"/);
    assert.deepEqual(bytes, fakeMp4, 'o download serve os bytes reais do ficheiro — nunca conteúdo inventado');
  });

  it('409 job_not_finished antes do fim (rendering)', async () => {
    const job = await createJob('pt-PT');
    store.update(job.id, { status: 'rendering', progress: 0.5 });
    const res = await fetch(`${base}/jobs/${job.id}/download`);
    assert.equal(res.status, 409);
    const json = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(json.error.code, 'job_not_finished');
    assert.ok(json.error.message.includes('rendering'), 'a mensagem diz o estado atual, em pt-PT');
  });

  it('409 video_not_ready: job done mas sem ficheiro em disco', async () => {
    const job = await createJob('pt-PT');
    store.update(job.id, { status: 'done', progress: 1, outputPath: join(scratchDir, 'nao-existe.mp4') });
    const res = await fetch(`${base}/jobs/${job.id}/download`);
    assert.equal(res.status, 409);
    const json = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(json.error.code, 'video_not_ready');
    assert.ok(json.error.message.length > 0, 'mensagem em pt-PT');
  });

  it('404 honesto para job desconhecido', async () => {
    const res = await fetch(`${base}/jobs/job-que-nao-existe/download`);
    assert.equal(res.status, 404);
    const json = (await res.json()) as { error: { code: string } };
    assert.equal(json.error.code, 'job_not_found');
  });

  it('405 para método não suportado em /download', async () => {
    const job = await createJob('pt-PT');
    const res = await fetch(`${base}/jobs/${job.id}/download`, { method: 'POST' });
    assert.equal(res.status, 405);
  });
});

describe('preview — contrato (Fase 3, render real ligado)', () => {
  const specFor = (job: Job): Spec => ({
    version: 1,
    title: 'Preview de teste',
    format: '9:16',
    language: 'pt-PT',
    segments: [
      {
        id: 'seg-01',
        narration: 'Narração de teste.',
        visualKeywords: [],
        brollDescription: '',
        targetDurationSec: 2,
      },
    ],
  });

  it('GET /api/jobs/:id/preview com Spec → 200 video/mp4 (inline, bytes reais)', async () => {
    const job = await createJob('pt-PT');
    store.update(job.id, { spec: specFor(job), status: 'awaiting-approval' });
    const { status, headers, bytes } = await getBytes(`/jobs/${job.id}/preview`);
    assert.equal(status, 200);
    assert.equal(headers.get('content-type'), 'video/mp4');
    assert.ok(!headers.get('content-disposition'), 'preview é inline, não attachment');
    assert.ok(bytes.subarray(4, 8).toString() === 'ftyp', 'é um MP4 real');
    assert.ok(bytes.length > 1000);
  });

  it('GET /api/jobs/:id/preview sem Spec → 409 preview_not_ready', async () => {
    const job = await createJob('pt-PT');
    const res = await fetch(`${base}/jobs/${job.id}/preview`);
    assert.equal(res.status, 409);
    const json = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(json.error.code, 'preview_not_ready');
    assert.ok(json.error.message.length > 0, 'mensagem em pt-PT');
  });

  it('preview de job desconhecido → 404 (o handler consulta o job)', async () => {
    const res = await fetch(`${base}/jobs/job-que-nao-existe/preview`);
    assert.equal(res.status, 404);
    const json = (await res.json()) as { error: { code: string } };
    assert.equal(json.error.code, 'job_not_found');
  });
});

describe('idiomas da Fase 3 — aceitação em POST /api/jobs', () => {
  const SUPPORTED = ['pt-PT', 'pt-BR', 'en', 'fr'] as const;
  for (const language of SUPPORTED) {
    it(`201 e job.language === '${language}'`, async () => {
      const job = await createJob(language);
      assert.equal(job.language, language);
      const stored = store.get(job.id);
      assert.equal(stored.language, language);
    });
  }

  it('omissão continua a ser pt-PT', async () => {
    const input: PipelineInput = { kind: 'topic', topic: 'tema' };
    const { status, json } = await post('/jobs', { input, format: '9:16' });
    assert.equal(status, 201);
    assert.equal((json as { job: Job }).job.language, 'pt-PT');
  });
});
