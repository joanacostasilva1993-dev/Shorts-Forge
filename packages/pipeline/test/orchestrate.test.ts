/**
 * Tests for orchestrate.ts — full job lifecycle with MOCKED LLM router and
 * MOCKED ServiceClients (no network, no Python services).
 * Run: npm test (tsc → node --test dist/test)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatRequest, PipelineInput, Spec } from '@shorts-forge/shared';
import { PipelineOrchestrator } from '../src/orchestrate.js';
import { ApiError, JobStore, type Job, type JobEvent } from '../src/jobs.js';
import type { ServiceClients } from '../src/pythonBridge.js';
import type { ServiceManager } from '../src/services.js';

function llmSpecJson() {
  return {
    title: 'Vídeo de teste',
    segments: [
      {
        id: 'seg-01',
        narration: 'Olá, este é o primeiro segmento do vídeo.',
        visualKeywords: ['sunrise'],
        brollDescription: 'Nascer do sol sobre a cidade',
        targetDurationSec: 4,
      },
      {
        id: 'seg-02',
        narration: 'E este é o segundo segmento, um pouco mais comprido.',
        visualKeywords: ['city'],
        brollDescription: 'Vista aérea de uma cidade',
        targetDurationSec: 5,
      },
    ],
  };
}

function mockRouter(data: unknown, capture: { req?: ChatRequest } = {}) {
  return {
    chatJson: async (req: ChatRequest): Promise<{ data: unknown }> => {
      capture.req = req;
      return { data };
    },
  };
}

/** Fake ServiceClients: TTS derives word timings from word count (deterministic). */
function mockServices(transcribeCalls?: { n: number }): ServiceClients {
  let synthCount = 0;
  const clients = {
    transcriptionBase: 'http://127.0.0.1:9',
    ttsBase: 'http://127.0.0.1:9',
    transcribe: async (_audioPath: string) => {
      if (transcribeCalls) transcribeCalls.n += 1;
      return {
        text: 'olá mundo teste de transcrição',
        words: [
          { word: 'olá', start: 0, end: 0.4 },
          { word: 'mundo', start: 0.4, end: 0.8 },
          { word: 'teste', start: 0.8, end: 1.1 },
          { word: 'de', start: 1.1, end: 1.25 },
          { word: 'transcrição', start: 1.25, end: 1.8 },
        ],
        language: 'pt',
      };
    },
    synthesize: async (text: string, voice: string, _rate = 1.0, _provider = 'kokoro') => {
      synthCount += 1;
      const tokens = text.split(/\s+/).filter((t) => t.length > 0);
      const words = tokens.map((word, i) => ({ word, start: i * 0.4, end: i * 0.4 + 0.35 }));
      const last = words[words.length - 1];
      return {
        audioPath: `/tmp/mock-tts-${synthCount}.wav`,
        words,
        durationSec: last ? last.end : 0.5,
        voice: voice || 'mock-voice',
      };
    },
    health: async () => ({ transcription: true, tts: true }),
  };
  return clients as unknown as ServiceClients;
}

function fakeServiceManager(): ServiceManager {
  return {
    ensureTranscription: async () => {},
    ensureTts: async () => {},
    shutdown: async () => {},
  } as unknown as ServiceManager;
}

let cacheDir = '';
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'sf-cache-'));
});
afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

function makeOrchestrator(
  router: { chatJson: (req: ChatRequest) => Promise<{ data: unknown }> },
  services?: ServiceClients,
): PipelineOrchestrator {
  return new PipelineOrchestrator({
    router,
    services: services ?? mockServices(),
    serviceManager: fakeServiceManager(),
    store: new JobStore(),
    transcriptCacheDir: cacheDir,
  });
}

async function waitForTerminal(
  orch: PipelineOrchestrator,
  id: string,
  timeoutMs = 15000,
): Promise<Job> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await orch.getJob(id);
    if (job.status === 'done' || job.status === 'failed') return job;
    if (Date.now() > deadline) throw new Error('timeout à espera do fim do job');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('ciclo de vida completo (topic)', () => {
  it('topic → spec → approve → render → done, com tts real (mock) e re-timing', async () => {
    const orch = makeOrchestrator(mockRouter(llmSpecJson()));
    const input: PipelineInput = { kind: 'topic', topic: 'hábitos matinais' };

    const created = await orch.createJob(input, { format: '9:16', language: 'pt-PT' });
    assert.equal(created.status, 'spec-draft');
    assert.equal(created.progress, 0);
    assert.ok(created.id.startsWith('job-'));

    const spec = await orch.generateSpec(created.id);
    assert.equal(spec.segments.length, 2);
    const afterA = await orch.getJob(created.id);
    assert.equal(afterA.status, 'awaiting-approval');
    assert.deepEqual(afterA.spec, spec);

    // Utilizador edita a narração e aprova.
    const edited: Spec = {
      ...spec,
      segments: spec.segments.map((s, i) =>
        i === 0 ? { ...s, narration: 'Narração editada pela Joana.' } : s,
      ),
    };
    const approved = await orch.approveSpec(created.id, edited);
    assert.equal(approved.status, 'awaiting-approval');
    const first = approved.spec?.segments[0];
    assert.ok(first);
    assert.equal(first.narration, 'Narração editada pela Joana.');

    // Fase B arranca (202-semântica: devolve logo o job em rendering).
    const rendering = await orch.render(created.id);
    assert.equal(rendering.status, 'rendering');

    const done = await waitForTerminal(orch, created.id);
    assert.equal(done.status, 'done');
    assert.equal(done.progress, 1);
    assert.ok(done.spec);

    // DoD da Fase 2: segments[].tts com durações reais + spec re-temporizada.
    for (const segment of done.spec.segments) {
      assert.ok(segment.tts, `segmento ${segment.id} devia ter tts`);
      assert.ok(segment.tts.words.length > 0, 'words[] reais do TTS');
      assert.ok(segment.tts.durationSec > 0, 'durationSec real');
      assert.ok(
        typeof segment.actualDurationSec === 'number' && segment.actualDurationSec > 0,
        `segmento ${segment.id} devia ter actualDurationSec`,
      );
      const lastWordEnd = Math.max(...segment.tts.words.map((w) => w.end));
      assert.ok(
        Math.abs(segment.actualDurationSec - (lastWordEnd + 0.25)) < 0.001,
        'actualDurationSec = fim da última palavra + 0.25s de respiro',
      );
    }
    // A narração editada foi mesmo a sintetizada (4 palavras → 4 words).
    const seg1 = done.spec.segments[0];
    assert.ok(seg1?.tts);
    assert.equal(seg1.tts.words.length, 4);
  });

  it('render sem Spec aprovada → 409 spec_missing', async () => {
    const orch = makeOrchestrator(mockRouter(llmSpecJson()));
    const job = await orch.createJob({ kind: 'topic', topic: 'x' }, { format: '9:16', language: 'pt-PT' });
    await assert.rejects(() => orch.render(job.id), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, 'spec_missing');
      assert.equal(err.httpStatus, 409);
      return true;
    });
  });

  it('segundo generateSpec enquanto o primeiro corre → 409 already_running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const router = {
      chatJson: async (_req: ChatRequest) => {
        await gate;
        return { data: llmSpecJson() };
      },
    };
    const orch = makeOrchestrator(router);
    const job = await orch.createJob({ kind: 'topic', topic: 'x' }, { format: '9:16', language: 'pt-PT' });
    const first = orch.generateSpec(job.id);
    await assert.rejects(() => orch.generateSpec(job.id), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, 'already_running');
      return true;
    });
    release();
    await first;
  });
});

describe('falhas', () => {
  it('LLM em baixo → job failed com mensagem acionável em pt-PT', async () => {
    const router = {
      chatJson: async (_req: ChatRequest): Promise<{ data: unknown }> => {
        throw new Error('All 3 attempted LLM provider(s) failed');
      },
    };
    const orch = makeOrchestrator(router);
    const job = await orch.createJob({ kind: 'topic', topic: 'x' }, { format: '9:16', language: 'pt-PT' });
    await assert.rejects(() => orch.generateSpec(job.id), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, 'llm_failed');
      return true;
    });
    const failed = await orch.getJob(job.id);
    assert.equal(failed.status, 'failed');
    assert.ok(failed.error && failed.error.includes('LLM'), 'mensagem menciona o LLM');
    assert.ok(failed.error.length > 20, 'mensagem acionável, não genérica');
  });

  it('PUT com spec inválida → 400 spec_invalid, job NÃO falha', async () => {
    const orch = makeOrchestrator(mockRouter(llmSpecJson()));
    const job = await orch.createJob({ kind: 'topic', topic: 'x' }, { format: '9:16', language: 'pt-PT' });
    await orch.generateSpec(job.id);
    const bad = { version: 1, title: 't', format: '9:16', language: 'pt-PT', segments: [] } as unknown as Spec;
    await assert.rejects(() => orch.approveSpec(job.id, bad), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, 'spec_invalid');
      assert.equal(err.httpStatus, 400);
      assert.match(err.message, /Spec inválida/);
      return true;
    });
    const still = await orch.getJob(job.id);
    assert.equal(still.status, 'awaiting-approval', 'o job continua aprovável após edição inválida');
  });

  it('serviço de TTS indisponível → render falha com mensagem pt-PT clara', async () => {
    const failingTts = {
      ...(mockServices() as unknown as Record<string, unknown>),
      synthesize: async () => {
        throw new Error('serviço de TTS indisponível — Fase 2 (sem ligação a http://127.0.0.1:8002)');
      },
    } as unknown as ServiceClients;
    const orch = makeOrchestrator(mockRouter(llmSpecJson()), failingTts);
    const job = await orch.createJob({ kind: 'topic', topic: 'x' }, { format: '9:16', language: 'pt-PT' });
    await orch.generateSpec(job.id);
    await orch.render(job.id);
    const failed = await waitForTerminal(orch, job.id);
    assert.equal(failed.status, 'failed');
    assert.ok(failed.error && failed.error.includes('TTS'), `mensagem clara: ${failed.error}`);
  });

  it('createJob com input inválido → 400', async () => {
    const orch = makeOrchestrator(mockRouter(llmSpecJson()));
    await assert.rejects(
      () =>
        orch.createJob({ kind: 'topic', topic: '   ' }, { format: '9:16', language: 'pt-PT' }),
      (err: unknown) => err instanceof ApiError && err.httpStatus === 400,
    );
    await assert.rejects(
      () =>
        orch.createJob({ kind: 'topic', topic: 'x' }, { format: '1:1' as never, language: 'pt-PT' }),
      (err: unknown) => err instanceof ApiError && err.httpStatus === 400,
    );
  });
});

describe('entrada por áudio (transcrição + cache)', () => {
  it('usa a cache: o mesmo áudio só é transcrito uma vez', async () => {
    const audioPath = join(cacheDir, 'voz.mp3');
    writeFileSync(audioPath, Buffer.from('fake-audio-bytes-123'));
    const calls = { n: 0 };
    const capture: { req?: ChatRequest } = {};
    const orch = makeOrchestrator(mockRouter(llmSpecJson(), capture), mockServices(calls));

    const input: PipelineInput = { kind: 'audio', audioPath };
    const job1 = await orch.createJob(input, { format: '9:16', language: 'pt-PT' });
    await orch.generateSpec(job1.id);
    assert.equal(calls.n, 1, 'primeira vez transcreve');

    // A transcrição vai parar ao prompt do LLM (com tempos reais).
    const userMsg = capture.req?.messages.find((m) => m.role === 'user')?.content ?? '';
    assert.ok(userMsg.includes('olá'), 'o prompt inclui a transcrição');

    const job2 = await orch.createJob(input, { format: '9:16', language: 'pt-PT' });
    await orch.generateSpec(job2.id);
    assert.equal(calls.n, 1, 'segunda vez usa a cache (sha256 dos bytes)');
  });

  it('ficheiro de áudio inexistente → erro pt-PT claro', async () => {
    const orch = makeOrchestrator(mockRouter(llmSpecJson()));
    const job = await orch.createJob(
      { kind: 'audio', audioPath: '/nao/existe/voz.mp3' },
      { format: '9:16', language: 'pt-PT' },
    );
    await assert.rejects(() => orch.generateSpec(job.id), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.match(err.message, /não foi possível ler o ficheiro de áudio/);
      return true;
    });
  });
});

describe('specEvents (AsyncIterable)', () => {
  it('emite spec-draft → awaiting-approval (stream fecha-se via return())', async () => {
    const orch = makeOrchestrator(mockRouter(llmSpecJson()));
    const job = await orch.createJob({ kind: 'topic', topic: 'x' }, { format: '9:16', language: 'pt-PT' });

    // The stream is long-lived by design (SSE): it only ends on done/failed
    // or when the consumer closes the iterator — like an SSE disconnect.
    const iterator = orch.specEvents(job.id)[Symbol.asyncIterator]();
    const seen: JobEvent[] = [];
    const pump = (async () => {
      for (;;) {
        const { value, done } = await iterator.next();
        if (done) return;
        seen.push(value);
      }
    })();
    // Deixa a subscrição registar-se antes de gerar.
    await new Promise((r) => setTimeout(r, 20));
    await orch.generateSpec(job.id);
    await iterator.return?.(undefined);
    await pump;

    const types = seen.map((e) => e.type);
    assert.ok(types.includes('spec-draft'), `visto: ${types.join(',')}`);
    assert.ok(types.includes('awaiting-approval'), `visto: ${types.join(',')}`);
    assert.ok(seen.every((e) => e.job.id === job.id), 'eventos com snapshot do job');
  });

  it('job desconhecido → 404', async () => {
    const orch = makeOrchestrator(mockRouter(llmSpecJson()));
    await assert.rejects(
      async () => {
        for await (const _ of orch.specEvents('job-inexistente')) {
          void _;
        }
      },
      (err: unknown) => err instanceof ApiError && err.code === 'job_not_found',
    );
  });
});
