/**
 * Contract tests for the Phase 2 Python services (transcription :8001, TTS :8002).
 *
 * Two layers:
 *   A. ServiceClients vs LOCAL FAKES (always runs, offline): locks the exact
 *      wire contract pythonBridge.ts implements — request bodies
 *      ({audioPath} / {text, voice, rate, provider}), the TranscriptionResult
 *      and TtsResult shapes it validates, and its pt-PT error behaviour.
 *   B. LIVE services (skipped with a reason when unreachable): probes the real
 *      Python servers on :8001/:8002 — GET /health shape, POST /transcribe
 *      with real audio, POST /synthesize for kokoro + edge-tts (real) and
 *      google (mocked — no credentials in this environment).
 *
 * A skipped-with-reason test is honest; a passing-but-meaningless test is a bug.
 * Run: npm test (tsc → node --test dist/test)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceClients } from '../src/pythonBridge.js';

const TRANSCRIPTION_BASE = 'http://127.0.0.1:8001';
const TTS_BASE = 'http://127.0.0.1:8002';
const PROBE_TIMEOUT_MS = 1500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeRoute {
  status: number;
  body: unknown;
}

/** Minimal JSON fake server that records the last request body per path. */
function startFake(routes: Record<string, FakeRoute>): Promise<{
  server: Server;
  base: string;
  lastBody: (path: string) => unknown;
}> {
  const seen = new Map<string, unknown>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const route = routes[url.pathname];
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      try {
        seen.set(url.pathname, raw ? JSON.parse(raw) : null);
      } catch {
        seen.set(url.pathname, raw);
      }
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'not_found', message: 'x' } }));
        return;
      }
      const payload = JSON.stringify(route.body);
      res.writeHead(route.status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      res.end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        lastBody: (path: string) => seen.get(path),
      });
    });
  });
}

function canonicalTranscription() {
  return {
    text: 'olá mundo',
    words: [
      { word: 'olá', start: 0.0, end: 0.42 },
      { word: 'mundo', start: 0.5, end: 0.95 },
    ],
    language: 'pt',
  };
}

function canonicalTts(voice: string) {
  return {
    audioPath: '/tmp/seg-1.wav',
    words: [
      { word: 'olá', start: 0.0, end: 0.38 },
      { word: 'mundo', start: 0.4, end: 0.9 },
    ],
    durationSec: 1.2,
    voice,
  };
}

function assertWordShape(w: unknown, label: string): void {
  assert.ok(typeof w === 'object' && w !== null, `${label} deve ser um objeto`);
  const o = w as Record<string, unknown>;
  assert.equal(typeof o['word'], 'string', `${label}.word é string`);
  assert.equal(typeof o['start'], 'number', `${label}.start é number`);
  assert.equal(typeof o['end'], 'number', `${label}.end é number`);
}

function assertTranscriptionShape(v: unknown): void {
  assert.ok(typeof v === 'object' && v !== null, 'TranscriptionResult é objeto');
  const o = v as Record<string, unknown>;
  assert.equal(typeof o['text'], 'string', 'text é string');
  assert.equal(typeof o['language'], 'string', 'language é string');
  assert.ok(Array.isArray(o['words']), 'words é array');
  (o['words'] as unknown[]).forEach((w, i) => assertWordShape(w, `words[${i}]`));
}

function assertTtsShape(v: unknown): void {
  assert.ok(typeof v === 'object' && v !== null, 'TtsResult é objeto');
  const o = v as Record<string, unknown>;
  assert.equal(typeof o['audioPath'], 'string', 'audioPath é string');
  assert.equal(typeof o['durationSec'], 'number', 'durationSec é number');
  assert.equal(typeof o['voice'], 'string', 'voice é string');
  assert.ok(Array.isArray(o['words']), 'words é array');
  (o['words'] as unknown[]).forEach((w, i) => assertWordShape(w, `words[${i}]`));
}

/** True when the service answers ANY HTTP response (even 4xx/5xx). */
async function serviceUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await res.arrayBuffer().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// A. ServiceClients vs local fakes (always runs)
// ---------------------------------------------------------------------------

describe('ServiceClients contract (local fakes)', () => {
  it('transcribe envia exatamente { audioPath } e valida TranscriptionResult', async () => {
    const { server, base, lastBody } = await startFake({
      '/transcribe': { status: 200, body: canonicalTranscription() },
      '/health': { status: 200, body: { ok: true } },
    });
    try {
      const clients = new ServiceClients({ transcription: base });
      const result = await clients.transcribe('/tmp/audio.wav');
      assertTranscriptionShape(result);
      assert.deepEqual(result, canonicalTranscription());
      const sent = lastBody('/transcribe') as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(sent).sort(),
        ['audioPath'],
        'corpo do /transcribe deve ter exatamente { audioPath }',
      );
      assert.equal(sent['audioPath'], '/tmp/audio.wav');
    } finally {
      server.close();
    }
  });

  it('transcribe rejeita resposta malformada com erro claro em pt-PT', async () => {
    const { server, base } = await startFake({
      '/transcribe': { status: 200, body: { text: 'falta words e language' } },
      '/health': { status: 200, body: { ok: true } },
    });
    try {
      const clients = new ServiceClients({ transcription: base });
      await assert.rejects(
        () => clients.transcribe('/tmp/audio.wav'),
        /resposta inválida do serviço de transcrição/,
      );
    } finally {
      server.close();
    }
  });

  it('transcribe rejeita words[] malformadas', async () => {
    const bad = canonicalTranscription();
    (bad.words as unknown[]).push({ word: 'x' }); // sem start/end
    const { server, base } = await startFake({
      '/transcribe': { status: 200, body: bad },
      '/health': { status: 200, body: { ok: true } },
    });
    try {
      const clients = new ServiceClients({ transcription: base });
      await assert.rejects(
        () => clients.transcribe('/tmp/audio.wav'),
        /resposta inválida do serviço de transcrição/,
      );
    } finally {
      server.close();
    }
  });

  it('transcribe num serviço inalcançável dá erro pt-PT (nunca hang)', async () => {
    const clients = new ServiceClients({ transcription: 'http://127.0.0.1:9' });
    await assert.rejects(
      () => clients.transcribe('/tmp/audio.wav'),
      /serviço de transcrição indisponível/,
    );
  });

  it('transcribe propaga HTTP não-2xx como erro pt-PT', async () => {
    const { server, base } = await startFake({
      '/transcribe': { status: 422, body: { error: { code: 'decode_error', message: 'x' } } },
      '/health': { status: 200, body: { ok: true } },
    });
    try {
      const clients = new ServiceClients({ transcription: base });
      await assert.rejects(
        () => clients.transcribe('/tmp/audio.wav'),
        /HTTP 422/,
      );
    } finally {
      server.close();
    }
  });

  it('synthesize envia exatamente { text, voice, rate, provider } (omissões)', async () => {
    const { server, base, lastBody } = await startFake({
      '/synthesize': { status: 200, body: canonicalTts('pf_dora') },
      '/health': { status: 200, body: { ok: true } },
    });
    try {
      const clients = new ServiceClients({ tts: base });
      const result = await clients.synthesize('Olá mundo.', 'pf_dora');
      assertTtsShape(result);
      assert.deepEqual(result, canonicalTts('pf_dora'));
      const sent = lastBody('/synthesize') as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(sent).sort(),
        ['provider', 'rate', 'text', 'voice'],
        'contrato final §4.4: { text, voice, rate, provider } — sem "language"',
      );
      assert.equal(sent['provider'], 'kokoro', 'omissão do provider é kokoro');
      assert.equal(sent['rate'], 1.0, 'omissão do rate é 1.0');
    } finally {
      server.close();
    }
  });

  it('synthesize passa rate e provider explícitos (ex. edge-tts)', async () => {
    const { server, base, lastBody } = await startFake({
      '/synthesize': { status: 200, body: canonicalTts('pt-PT-DuarteNeural') },
      '/health': { status: 200, body: { ok: true } },
    });
    try {
      const clients = new ServiceClients({ tts: base });
      await clients.synthesize('Olá mundo.', 'pt-PT-DuarteNeural', 1.25, 'edge-tts');
      const sent = lastBody('/synthesize') as Record<string, unknown>;
      assert.equal(sent['provider'], 'edge-tts');
      assert.equal(sent['rate'], 1.25);
      assert.equal(sent['voice'], 'pt-PT-DuarteNeural');
    } finally {
      server.close();
    }
  });

  it('synthesize (provider google, MOCKADO — sem credenciais) valida TtsResult', async () => {
    // O provider google é testado contra um fake local: sem credenciais Google
    // neste ambiente, chamar a cloud real seria impossível e errado.
    const { server, base, lastBody } = await startFake({
      '/synthesize': { status: 200, body: canonicalTts('pt-PT-Neural2-A') },
      '/health': { status: 200, body: { ok: true } },
    });
    try {
      const clients = new ServiceClients({ tts: base });
      const result = await clients.synthesize('Olá mundo.', 'pt-PT-Neural2-A', 1.0, 'google');
      assertTtsShape(result);
      assert.equal(result.voice, 'pt-PT-Neural2-A');
      const sent = lastBody('/synthesize') as Record<string, unknown>;
      assert.equal(sent['provider'], 'google');
    } finally {
      server.close();
    }
  });

  it('synthesize rejeita resposta malformada com erro claro em pt-PT', async () => {
    const { server, base } = await startFake({
      '/synthesize': { status: 200, body: { audioPath: '/x.wav' } },
      '/health': { status: 200, body: { ok: true } },
    });
    try {
      const clients = new ServiceClients({ tts: base });
      await assert.rejects(
        () => clients.synthesize('Olá.', 'pf_dora'),
        /resposta inválida do serviço de TTS/,
      );
    } finally {
      server.close();
    }
  });

  it('synthesize num serviço inalcançável dá erro pt-PT (nunca hang)', async () => {
    const clients = new ServiceClients({ tts: 'http://127.0.0.1:9' });
    await assert.rejects(
      () => clients.synthesize('Olá.', 'pf_dora'),
      /serviço de TTS indisponível/,
    );
  });

  it('health() reporta ambos os serviços; nunca lança', async () => {
    const { server, base } = await startFake({
      '/health': { status: 200, body: { ok: true } },
    });
    try {
      const clients = new ServiceClients({
        transcription: base,
        tts: 'http://127.0.0.1:9', // porta fechada
      });
      const h = await clients.health();
      assert.deepEqual(h, { transcription: true, tts: false });
    } finally {
      server.close();
    }
  });

  it('health() com ambos em baixo devolve false/false sem lançar', async () => {
    const clients = new ServiceClients({
      transcription: 'http://127.0.0.1:9',
      tts: 'http://127.0.0.1:9',
    });
    const h = await clients.health();
    assert.deepEqual(h, { transcription: false, tts: false });
  });
});

// ---------------------------------------------------------------------------
// B. Live services (skip com motivo quando o serviço não está a correr)
// ---------------------------------------------------------------------------

const SKIP_TRANSCRIPTION =
  'serviço de transcrição não está a correr em 127.0.0.1:8001 — ' +
  'arrancar com: python3 packages/transcription/service/server.py';
const SKIP_TTS =
  'serviço de TTS não está a correr em 127.0.0.1:8002 — ainda não implementado (Fase 2)';

describe('live: transcription :8001', () => {
  it('GET /health responde 200 com { ok: true, ... }', async (t) => {
    if (!(await serviceUp(`${TRANSCRIPTION_BASE}/health`))) {
      t.skip(SKIP_TRANSCRIPTION);
      return;
    }
    const res = await fetch(`${TRANSCRIPTION_BASE}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['ok'], true, 'health deve devolver { ok: true, ... }');
    assert.ok(
      Array.isArray(body['modelsLoaded']),
      'health deve incluir modelsLoaded[]',
    );
  });

  it('POST /transcribe com áudio real devolve TranscriptionResult', async (t) => {
    if (!(await serviceUp(`${TRANSCRIPTION_BASE}/health`))) {
      t.skip(SKIP_TRANSCRIPTION);
      return;
    }
    // Fixture real: tom gerado por ffmpeg (sem fala → words pode vir vazio,
    // mas a FORMA do contrato tem de estar certa).
    const wav = join(tmpdir(), 'shorts-forge-contract-tone.wav');
    try {
      execFileSync(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
          '-i', 'sine=frequency=440:duration=2', '-ar', '16000', '-ac', '1', wav],
        { timeout: 15000 },
      );
    } catch {
      t.skip('ffmpeg indisponível para gerar a fixture de áudio');
      return;
    }

    const res = await fetch(`${TRANSCRIPTION_BASE}/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audioPath: wav }),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (res.status === 200) {
      const clients = new ServiceClients();
      const result = await clients.transcribe(wav);
      assertTranscriptionShape(result);
      assert.ok(
        result.words.every((w) => w.end >= w.start),
        'timestamps de palavra têm de ser não-negativos (end >= start)',
      );
      return;
    }
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: string };
    };
    if (res.status >= 500 && body.error?.code === 'model_error') {
      t.skip(
        'modelo faster-whisper não carregável neste ambiente — ' +
          'o teste real requer `npm run models:download`',
      );
      return;
    }
    assert.fail(
      `POST /transcribe violou o contrato: HTTP ${res.status} — ${JSON.stringify(body)}`,
    );
  });

  it('POST /transcribe com audioPath inexistente devolve 404 com envelope de erro', async (t) => {
    if (!(await serviceUp(`${TRANSCRIPTION_BASE}/health`))) {
      t.skip(SKIP_TRANSCRIPTION);
      return;
    }
    const res = await fetch(`${TRANSCRIPTION_BASE}/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audioPath: '/não/existe.wav' }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    assert.equal(body.error?.code, 'audio_not_found');
    assert.ok(typeof body.error?.message === 'string' && body.error.message.length > 0);
  });
});

describe('live: TTS :8002', () => {
  it('GET /health responde 200 com { ok: true, ... }', async (t) => {
    if (!(await serviceUp(`${TTS_BASE}/health`))) {
      t.skip(SKIP_TTS);
      return;
    }
    const res = await fetch(`${TTS_BASE}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['ok'], true, 'health deve devolver { ok: true, ... }');
  });

  for (const provider of ['kokoro', 'edge-tts'] as const) {
    it(`POST /synthesize (${provider}, real) devolve TtsResult`, async (t) => {
      if (!(await serviceUp(`${TTS_BASE}/health`))) {
        t.skip(SKIP_TTS);
        return;
      }
      const clients = new ServiceClients();
      const voice = provider === 'kokoro' ? 'pf_dora' : 'pt-PT-DuarteNeural';
      const result = await clients.synthesize('Olá mundo.', voice, 1.0, provider);
      assertTtsShape(result);
      assert.equal(result.voice, voice);
      assert.ok(result.durationSec > 0, 'durationSec tem de ser > 0');
      assert.ok(
        result.words.every((w) => w.end >= w.start),
        'timestamps de palavra têm de ser não-negativos',
      );
    });
  }

  // NOTA: o provider google é testado via mock na secção A — sem
  // GOOGLE_TTS_API_KEY / GOOGLE_APPLICATION_CREDENTIALS não há como
  // chamar a cloud real neste ambiente, e fazê-lo seria errado.
});

