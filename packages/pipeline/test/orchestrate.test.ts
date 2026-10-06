/**
 * Tests for orchestrate.ts — full job lifecycle with MOCKED LLM router and
 * MOCKED ServiceClients (no network, no Python services).
 * Run: npm test (tsc → node --test dist/test)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatRequest, PipelineInput, Spec } from '@shorts-forge/shared';
import { PipelineOrchestrator } from '../src/orchestrate.js';
import { ApiError, JobStore, type Job, type JobEvent } from '../src/jobs.js';
import type { ServiceClients } from '../src/pythonBridge.js';
import type { ServiceManager } from '../src/services.js';
import { jobOutputsDir } from '../src/outputs.js';
import { QC_REPORT_FILENAME } from '../src/qc.js';

/** O QC corre ffmpeg/ffprobe reais — sem eles, os testes de ciclo completo saltam. */
const HAVE_QC_TOOLS = ((): boolean => {
  try {
    const r = spawnSync('ffprobe', ['-hide_banner', '-version'], { timeout: 10_000 });
    return r.status === 0;
  } catch {
    return false;
  }
})();

/**
 * Gera um MP4 real minúsculo para o double de render dos testes.
 * `good` honra a duração total da Spec (passa no QC); `broken` é
 * silencioso + preto (chumba no QC de propósito).
 */
function writeTestFixtureMp4(outPath: string, durationSec: number, broken: boolean): void {
  const videoSrc = broken
    ? `color=c=black:size=320x240:rate=30:duration=${durationSec}`
    : `testsrc=size=320x240:rate=30:duration=${durationSec}`;
  const audioSrc = broken
    ? `anullsrc=r=48000:cl=stereo:d=${durationSec}`
    : `sine=frequency=440:duration=${durationSec}`;
  mkdirSync(join(outPath, '..'), { recursive: true });
  const res = spawnSync(
    'ffmpeg',
    [
      '-hide_banner', '-y',
      '-f', 'lavfi', '-i', videoSrc,
      '-f', 'lavfi', '-i', audioSrc,
      '-af', broken ? 'anull' : 'loudnorm=I=-16:TP=-1.5:LRA=11',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-shortest',
      outPath,
    ],
    { timeout: 120_000, encoding: 'utf8' },
  );
  if (res.error || res.status !== 0 || !existsSync(outPath)) {
    throw new Error(
      `double de render (teste) falhou: ${String(res.error ?? res.stderr ?? '').slice(-1200)}`,
    );
  }
}

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
let outputsDir = '';
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'sf-cache-'));
  // Os renders dos testes escrevem ficheiros reais (o QC analisa-os) —
  // vão para um tmpdir, nunca para o repo.
  outputsDir = mkdtempSync(join(tmpdir(), 'sf-outputs-'));
  process.env.SHORTS_FORGE_OUTPUTS_DIR = outputsDir;
});
afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  rmSync(outputsDir, { recursive: true, force: true });
  delete process.env.SHORTS_FORGE_OUTPUTS_DIR;
});

function makeOrchestrator(
  router: { chatJson: (req: ChatRequest) => Promise<{ data: unknown }> },
  services?: ServiceClients,
  renderMode: 'good' | 'broken-first' = 'good',
): PipelineOrchestrator {
  let calls = 0;
  return new PipelineOrchestrator({
    router,
    services: services ?? mockServices(),
    serviceManager: fakeServiceManager(),
    store: new JobStore(),
    transcriptCacheDir: cacheDir,
    // Double de vídeo que gera MP4s REAIS (o QC da Fase B analisa-os a sério):
    // 'good' passa sempre; 'broken-first' parte o primeiro render e passa nos seguintes.
    renderVideo: async (spec, opts) => {
      assert.ok(spec.segments.length > 0, 'renderVideo recebe a Spec re-temporizada');
      assert.ok(opts.outDir.length > 0);
      calls += 1;
      const broken = renderMode === 'broken-first' && calls === 1;
      const total = spec.segments.reduce(
        (acc, s) => acc + (s.actualDurationSec ?? s.targetDurationSec),
        0,
      );
      const outPath = join(opts.outDir, 'final.mp4');
      writeTestFixtureMp4(outPath, total, broken);
      return outPath;
    },
  });
}

async function waitForTerminal(
  orch: PipelineOrchestrator,
  id: string,
  timeoutMs = 30000,
): Promise<Job> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await orch.getJob(id);
    if (job.status === 'done' || job.status === 'failed' || job.status === 'qc-failed') {
      return job;
    }
    if (Date.now() > deadline) throw new Error('timeout à espera do fim do job');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('ciclo de vida completo (topic)', () => {
  it('topic → spec → approve → render → QC → done, com tts real (mock) e re-timing', async (t) => {
    if (!HAVE_QC_TOOLS) {
      t.skip('ffmpeg/ffprobe indisponíveis — o QC real não pode correr');
      return;
    }
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
    // A Fase B termina com o MP4 final (o passo de vídeo foi chamado).
    assert.ok(
      done.outputPath?.endsWith('final.mp4'),
      `outputPath aponta para o MP4 final: ${done.outputPath}`,
    );
    // A etapa de QC correu a sério e escreveu o relatório.
    assert.ok(
      existsSync(join(jobOutputsDir(done.id), QC_REPORT_FILENAME)),
      'qc-report.json existe em outputs/<jobId>/',
    );

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

describe('i18n end-to-end (idioma → transcrição → LLM → TTS → legendas)', () => {
  const ENV_KEYS = ['TTS_ENGINE', 'KOKORO_VOICE', 'EDGE_TTS_VOICE', 'GOOGLE_TTS_VOICE', 'SPEECH_RATE'];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  /** mockServices variant that captures synthesize/transcribe arguments. */
  function capturingServices(capture: {
    synth?: { text: string; voice: string; rate: number; provider: string }[];
    transcribeLang?: string[];
  }): ServiceClients {
    let synthCount = 0;
    return {
      transcriptionBase: 'http://127.0.0.1:9',
      ttsBase: 'http://127.0.0.1:9',
      transcribe: async (_audioPath: string, language?: string) => {
        capture.transcribeLang?.push(language ?? '');
        return {
          text: 'olá mundo',
          words: [
            { word: 'olá', start: 0, end: 0.4 },
            { word: 'mundo', start: 0.4, end: 0.8 },
          ],
          language: 'pt',
        };
      },
      synthesize: async (text: string, voice: string, rate = 1.0, provider = 'kokoro') => {
        synthCount += 1;
        capture.synth?.push({ text, voice, rate, provider });
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
    } as unknown as ServiceClients;
  }

  function fullCycle(
    orch: PipelineOrchestrator,
    input: PipelineInput,
    opts: { format: '9:16' | '16:9'; language: string; ttsChoice?: { engine?: string; voice?: string } },
  ) {
    return (async () => {
      const created = await orch.createJob(input, opts);
      const spec = await orch.generateSpec(created.id);
      await orch.approveSpec(created.id, spec);
      await orch.render(created.id);
      return waitForTerminal(orch, created.id);
    })();
  }

  it('createJob rejeita idioma não suportado (400 unsupported_language)', async () => {
    const orch = makeOrchestrator(mockRouter(llmSpecJson()));
    await assert.rejects(
      orch.createJob({ kind: 'topic', topic: 'x' }, { format: '9:16', language: 'de' }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, 'unsupported_language');
        assert.equal(err.httpStatus, 400);
        return true;
      },
    );
  });

  it('createJob aceita os 4 idiomas e guarda a escolha de voz da UI', async () => {
    const orch = makeOrchestrator(mockRouter(llmSpecJson()));
    for (const language of ['pt-PT', 'pt-BR', 'en', 'fr']) {
      const job = await orch.createJob(
        { kind: 'topic', topic: 'x' },
        { format: '9:16', language, ttsChoice: { engine: 'edge', voice: 'custom-voice' } },
      );
      assert.equal(job.language, language);
      assert.deepEqual(job.ttsChoice, { engine: 'edge', voice: 'custom-voice' });
    }
  });

  it('job francês: Fase B usa a voz omissa do catálogo (edge-tts/fr-FR-DeniseNeural)', async (t) => {
    if (!HAVE_QC_TOOLS) {
      t.skip('ffmpeg/ffprobe indisponíveis — o QC real não pode correr');
      return;
    }
    const capture: { synth?: { text: string; voice: string; rate: number; provider: string }[] } = { synth: [] };
    const orch = makeOrchestrator(mockRouter(llmSpecJson()), capturingServices(capture));
    const done = await fullCycle(orch, { kind: 'topic', topic: 'bonjour' }, { format: '9:16', language: 'fr' });
    assert.equal(done.status, 'done');
    assert.ok(capture.synth && capture.synth.length > 0);
    for (const s of capture.synth) {
      // Decisão da Joana (2026-10-06): ff_siwis REJEITADA (robótica, sotaque
      // misto) — a omissão francesa é Edge-TTS fr-FR-DeniseNeural.
      assert.equal(s.provider, 'edge-tts');
      assert.equal(s.voice, 'fr-FR-DeniseNeural');
    }
  });

  it('job pt-PT: Fase B usa a voz omissa do catálogo (edge-tts/pt-PT-DuarteNeural)', async (t) => {
    if (!HAVE_QC_TOOLS) {
      t.skip('ffmpeg/ffprobe indisponíveis — o QC real não pode correr');
      return;
    }
    const capture: { synth?: { text: string; voice: string; rate: number; provider: string }[] } = { synth: [] };
    const orch = makeOrchestrator(mockRouter(llmSpecJson()), capturingServices(capture));
    const done = await fullCycle(orch, { kind: 'topic', topic: 'olá' }, { format: '9:16', language: 'pt-PT' });
    assert.equal(done.status, 'done');
    for (const s of capture.synth ?? []) {
      assert.equal(s.provider, 'edge-tts');
      assert.equal(s.voice, 'pt-PT-DuarteNeural');
    }
  });

  it('escolha explícita da UI (ttsChoice) vence o catálogo na Fase B', async (t) => {
    if (!HAVE_QC_TOOLS) {
      t.skip('ffmpeg/ffprobe indisponíveis — o QC real não pode correr');
      return;
    }
    const capture: { synth?: { text: string; voice: string; rate: number; provider: string }[] } = { synth: [] };
    const orch = makeOrchestrator(mockRouter(llmSpecJson()), capturingServices(capture));
    const done = await fullCycle(
      orch,
      { kind: 'topic', topic: 'olá' },
      { format: '9:16', language: 'pt-PT', ttsChoice: { engine: 'kokoro', voice: 'pm_alex' } },
    );
    assert.equal(done.status, 'done');
    for (const s of capture.synth ?? []) {
      assert.equal(s.provider, 'kokoro');
      assert.equal(s.voice, 'pm_alex');
    }
  });

  it('transcrição recebe o idioma do job como hint', async () => {
    const audioPath = join(cacheDir, 'voz-fr.mp3');
    writeFileSync(audioPath, Buffer.from('fake-audio-bytes-fr'));
    const capture: { transcribeLang?: string[] } = { transcribeLang: [] };
    const orch = makeOrchestrator(mockRouter(llmSpecJson()), capturingServices(capture));
    const job = await orch.createJob({ kind: 'audio', audioPath }, { format: '9:16', language: 'fr' });
    await orch.generateSpec(job.id);
    assert.deepEqual(capture.transcribeLang, ['fr']);
  });
});

describe('etapa de QC (Fase 4)', () => {
  async function approvedJob(
    orch: PipelineOrchestrator,
  ): Promise<{ id: string }> {
    const created = await orch.createJob(
      { kind: 'topic', topic: 'hábitos matinais' },
      { format: '9:16', language: 'pt-PT' },
    );
    const spec = await orch.generateSpec(created.id);
    await orch.approveSpec(created.id, spec);
    return { id: created.id };
  }

  function totalDuration(spec: Spec): number {
    return spec.segments.reduce(
      (acc, s) => acc + (s.actualDurationSec ?? s.targetDurationSec),
      0,
    );
  }

  it('render partido (silencioso+preto) → qc-failed com motivos pt-PT e eventos qc/qc-failed', async (t) => {
    if (!HAVE_QC_TOOLS) {
      t.skip('ffmpeg/ffprobe indisponíveis — o QC real não pode correr');
      return;
    }
    const orch = makeOrchestrator(mockRouter(llmSpecJson()), undefined, 'broken-first');
    const { id } = await approvedJob(orch);

    const eventTypes: string[] = [];
    const unsubscribe = orch.jobStore.subscribe(id, (e) => eventTypes.push(e.type));

    const rendering = await orch.render(id);
    assert.equal(rendering.status, 'rendering');

    const terminal = await waitForTerminal(orch, id);
    unsubscribe();
    assert.equal(terminal.status, 'qc-failed');
    assert.ok(
      terminal.error && terminal.error.includes('não passou no controlo de qualidade'),
      `motivos em pt-PT: ${terminal.error}`,
    );
    assert.match(terminal.error ?? '', /silêncio/);
    assert.match(terminal.error ?? '', /preta/);
    assert.ok(eventTypes.includes('qc'), `eventos incluem "qc": ${eventTypes.join(',')}`);
    assert.ok(
      eventTypes.includes('qc-failed'),
      `eventos incluem "qc-failed": ${eventTypes.join(',')}`,
    );
    assert.ok(
      existsSync(join(jobOutputsDir(id), QC_REPORT_FILENAME)),
      'qc-report.json escrito em outputs/<jobId>/',
    );
    // O vídeo mau continua referenciado (para o retryQc o reanalisar).
    assert.ok(terminal.outputPath?.endsWith('final.mp4'));
  });

  it('retryQc recupera um qc-failed quando o vídeo é corrigido', async (t) => {
    if (!HAVE_QC_TOOLS) {
      t.skip('ffmpeg/ffprobe indisponíveis — o QC real não pode correr');
      return;
    }
    const orch = makeOrchestrator(mockRouter(llmSpecJson()), undefined, 'broken-first');
    const { id } = await approvedJob(orch);
    await orch.render(id);
    const failed = await waitForTerminal(orch, id);
    assert.equal(failed.status, 'qc-failed');
    assert.ok(failed.outputPath && failed.spec);

    // A Joana (ou um fix externo) substitui o MP4 por um vídeo bom.
    writeTestFixtureMp4(failed.outputPath, totalDuration(failed.spec), false);

    const retrying = await orch.retryQc(id);
    assert.equal(retrying.status, 'qc');

    const done = await waitForTerminal(orch, id);
    assert.equal(done.status, 'done');
    assert.equal(done.error, undefined, 'o erro do QC é limpo ao recuperar');
  });

  it('render a partir de qc-failed recomeça a Fase B completa', async (t) => {
    if (!HAVE_QC_TOOLS) {
      t.skip('ffmpeg/ffprobe indisponíveis — o QC real não pode correr');
      return;
    }
    const orch = makeOrchestrator(mockRouter(llmSpecJson()), undefined, 'broken-first');
    const { id } = await approvedJob(orch);
    await orch.render(id);
    const failed = await waitForTerminal(orch, id);
    assert.equal(failed.status, 'qc-failed');

    // O segundo render usa o double "bom" — a Fase B corre de novo.
    const rendering = await orch.render(id);
    assert.equal(rendering.status, 'rendering');
    const done = await waitForTerminal(orch, id);
    assert.equal(done.status, 'done');
  });

  it('retryQc fora de qc-failed → 409 invalid_state', async () => {
    const orch = makeOrchestrator(mockRouter(llmSpecJson()));
    const { id } = await approvedJob(orch);
    await assert.rejects(() => orch.retryQc(id), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, 'invalid_state');
      assert.equal(err.httpStatus, 409);
      return true;
    });
  });

  it('render rejeita jobs em estado terminal (failed não re-renderiza)', async () => {
    const orch = makeOrchestrator(mockRouter(llmSpecJson()));
    const created = await orch.createJob(
      { kind: 'topic', topic: 'x' },
      { format: '9:16', language: 'pt-PT' },
    );
    const spec = await orch.generateSpec(created.id);
    await orch.approveSpec(created.id, spec);
    orch.jobStore.update(created.id, { status: 'failed', error: 'falha simulada' });
    await assert.rejects(() => orch.render(created.id), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, 'invalid_state');
      assert.equal(err.httpStatus, 409);
      return true;
    });
  });
});

describe('presets de plataforma', () => {
  it('createJob: preset explícito ganha sobre format e fica guardado no job', async () => {
    const orch = makeOrchestrator(mockRouter(llmSpecJson()));
    const job = await orch.createJob(
      { kind: 'topic', topic: 'x' },
      { format: '16:9', language: 'pt-PT', preset: 'tiktok' },
    );
    assert.equal(job.preset, 'tiktok');
    assert.equal(job.format, '9:16');
  });

  it('createJob: sem preset, o format resolve para o preset omisso da proporção', async () => {
    const orch = makeOrchestrator(mockRouter(llmSpecJson()));
    const wide = await orch.createJob(
      { kind: 'topic', topic: 'x' },
      { format: '16:9', language: 'pt-PT' },
    );
    assert.equal(wide.preset, 'youtube-long');
    assert.equal(wide.format, '16:9');
    const vertical = await orch.createJob(
      { kind: 'topic', topic: 'x' },
      { format: '9:16', language: 'pt-PT' },
    );
    assert.equal(vertical.preset, 'youtube-shorts');
  });

  it('createJob: preset desconhecido → 400 invalid_input', async () => {
    const orch = makeOrchestrator(mockRouter(llmSpecJson()));
    await assert.rejects(
      () =>
        orch.createJob(
          { kind: 'topic', topic: 'x' },
          { format: '9:16', language: 'pt-PT', preset: 'vimeo' as 'tiktok' },
        ),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, 'invalid_input');
        assert.equal(err.httpStatus, 400);
        return true;
      },
    );
  });

  it('Fase B: o preset do job chega ao passo de vídeo (renderVideo)', async (t) => {
    if (!HAVE_QC_TOOLS) {
      t.skip('ffmpeg/ffprobe indisponíveis — o QC real não pode correr');
      return;
    }
    const seen: { preset?: string | undefined; format?: string | undefined }[] = [];
    const orch = new PipelineOrchestrator({
      router: mockRouter(llmSpecJson()),
      services: mockServices(),
      serviceManager: fakeServiceManager(),
      store: new JobStore(),
      transcriptCacheDir: cacheDir,
      renderVideo: async (spec, opts) => {
        seen.push({ preset: opts.preset, format: opts.format });
        const total = spec.segments.reduce(
          (acc, s) => acc + (s.actualDurationSec ?? s.targetDurationSec),
          0,
        );
        const outPath = join(opts.outDir, 'final.mp4');
        writeTestFixtureMp4(outPath, total, false);
        return outPath;
      },
    });
    const job = await orch.createJob(
      { kind: 'topic', topic: 'hábitos matinais' },
      { format: '9:16', language: 'pt-PT', preset: 'instagram-reels' },
    );
    const spec = await orch.generateSpec(job.id);
    await orch.approveSpec(job.id, spec);
    await orch.render(job.id);
    const done = await waitForTerminal(orch, job.id);
    assert.equal(done.status, 'done');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.preset, 'instagram-reels');
    assert.equal(seen[0]!.format, '9:16');
  });
});
