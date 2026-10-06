/**
 * Contract tests for platform presets on POST /api/jobs (docs/platforms.md):
 * the `preset` field is accepted, an explicit preset wins over a
 * conflicting `format`, a bare `format` resolves to the aspect's default
 * preset, and unknown preset ids are rejected with 400.
 *
 * The real PipelineOrchestrator is used (createJob only validates + stores,
 * so stub deps are enough); HTTP behaviour goes through the real server.
 * Run: npm test (tsc → node --test dist/test)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { ChatRequest, PipelineInput } from '@shorts-forge/shared';
import { createServer } from '../src/server.js';
import { PipelineOrchestrator } from '../src/orchestrate.js';
import { JobStore, type Job } from '../src/jobs.js';
import type { ServiceClients } from '../src/pythonBridge.js';
import type { ServiceManager } from '../src/services.js';

let server: Server;
let base = '';

before(async () => {
  // Real orchestrator with stub deps: createJob never touches them.
  const pipeline = new PipelineOrchestrator({
    router: { chatJson: async (_req: ChatRequest) => ({ data: {} }) },
    services: {} as ServiceClients,
    serviceManager: {} as ServiceManager,
    store: new JobStore(),
  });
  server = createServer({
    pipeline,
    chat: async (_req: ChatRequest) => ({ text: 'x', provider: 'fake', model: 'fake-1' }),
    llmStatus: async () => [],
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}/api`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function input(): PipelineInput {
  return { kind: 'topic', topic: 'hábitos matinais' };
}

describe('POST /api/jobs — platform presets', () => {
  it('accepts a preset and stores it on the job', async () => {
    const { status, json } = await post('/jobs', {
      input: input(),
      format: '9:16',
      language: 'pt-PT',
      preset: 'tiktok',
    });
    assert.equal(status, 201);
    const job = json.job as Job;
    assert.equal(job.preset, 'tiktok');
    assert.equal(job.format, '9:16');
  });

  it('an explicit preset wins over a conflicting format', async () => {
    const { status, json } = await post('/jobs', {
      input: input(),
      format: '16:9',
      language: 'pt-PT',
      preset: 'tiktok',
    });
    assert.equal(status, 201);
    const job = json.job as Job;
    assert.equal(job.preset, 'tiktok');
    assert.equal(job.format, '9:16');
  });

  it('a preset alone implies its format', async () => {
    const { status, json } = await post('/jobs', {
      input: input(),
      language: 'pt-PT',
      preset: 'youtube-long',
    });
    assert.equal(status, 201);
    const job = json.job as Job;
    assert.equal(job.preset, 'youtube-long');
    assert.equal(job.format, '16:9');
  });

  it('a bare format resolves to the aspect default preset', async () => {
    const wide = await post('/jobs', {
      input: input(),
      format: '16:9',
      language: 'pt-PT',
    });
    assert.equal(wide.status, 201);
    assert.equal((wide.json.job as Job).preset, 'youtube-long');

    const vertical = await post('/jobs', {
      input: input(),
      format: '9:16',
      language: 'pt-PT',
    });
    assert.equal(vertical.status, 201);
    assert.equal((vertical.json.job as Job).preset, 'youtube-shorts');
  });

  it('rejects an unknown preset with 400', async () => {
    const { status, json } = await post('/jobs', {
      input: input(),
      format: '9:16',
      language: 'pt-PT',
      preset: 'vimeo',
    });
    assert.equal(status, 400);
    assert.equal(json.error.code, 'invalid_input');
    assert.match(json.error.message, /tiktok/);
  });

  it('rejects a non-string preset with 400', async () => {
    const { status, json } = await post('/jobs', {
      input: input(),
      format: '9:16',
      language: 'pt-PT',
      preset: 42,
    });
    assert.equal(status, 400);
    assert.equal(json.error.code, 'invalid_input');
  });
});
