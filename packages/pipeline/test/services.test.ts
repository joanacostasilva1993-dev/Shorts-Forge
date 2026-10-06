/**
 * Tests for services.ts (lifecycle failure paths — never hangs, always a
 * clear pt-PT error) and ttsConfig.ts (env resolution).
 * Run: npm test (tsc → node --test dist/test)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceClients } from '../src/pythonBridge.js';
import { ServiceManager } from '../src/services.js';
import { resolveTtsConfig } from '../src/ttsConfig.js';
import { ApiError } from '../src/jobs.js';

/** Clients pointed at a surely-closed port: health() is false, fast. */
function deadClients(): ServiceClients {
  return new ServiceClients({
    transcription: 'http://127.0.0.1:9',
    tts: 'http://127.0.0.1:9',
  });
}

const ENV_KEYS = [
  'TTS_ENGINE',
  'KOKORO_VOICE',
  'EDGE_TTS_VOICE',
  'GOOGLE_TTS_VOICE',
  'SPEECH_RATE',
  'TRANSCRIPTION_SERVICE_CMD',
  'TTS_SERVICE_CMD',
];
let savedEnv: Record<string, string | undefined> = {};

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

describe('ServiceManager — falhas claras, sem hangs', () => {
  it('TTS indisponível e sem comando de spawn → erro pt-PT acionável', async () => {
    const manager = new ServiceManager(deadClients(), {
      allowSpawn: false,
      checkIntervalMs: 0,
    });
    try {
      await assert.rejects(() => manager.ensureTts(), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /serviço de TTS indisponível/);
        assert.match(err.message, /TTS_SERVICE_CMD/);
        assert.match(err.message, /models:download/);
        return true;
      });
    } finally {
      await manager.shutdown();
    }
  });

  it('transcrição indisponível e sem comando de spawn → erro pt-PT acionável', async () => {
    const manager = new ServiceManager(deadClients(), {
      allowSpawn: false,
      checkIntervalMs: 0,
    });
    try {
      await assert.rejects(() => manager.ensureTranscription(), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /serviço de transcrição indisponível/);
        assert.match(err.message, /TRANSCRIPTION_SERVICE_CMD/);
        return true;
      });
    } finally {
      await manager.shutdown();
    }
  });

  it('comando de spawn que falha → erro claro e limitado no tempo', async () => {
    process.env.TTS_SERVICE_CMD = 'comando-que-nao-existe-xyz-123 --port 8002';
    const manager = new ServiceManager(deadClients(), {
      spawnTimeoutMs: 4000,
      checkIntervalMs: 0,
    });
    const started = Date.now();
    try {
      await assert.rejects(() => manager.ensureTts(), (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /não foi possível arrancar o serviço de TTS/);
        return true;
      });
    } finally {
      await manager.shutdown();
    }
    assert.ok(Date.now() - started < 15000, 'não fica pendurado');
  });

  it('shutdown() é idempotente e não lança', async () => {
    const manager = new ServiceManager(deadClients(), { checkIntervalMs: 0 });
    await manager.shutdown();
    await manager.shutdown();
  });
});

describe('resolveTtsConfig', () => {
  it('omissões: kokoro, voz do serviço, rate 1.0', () => {
    const cfg = resolveTtsConfig();
    assert.equal(cfg.provider, 'kokoro');
    assert.equal(cfg.voice, '');
    assert.equal(cfg.rate, 1.0);
  });

  it('TTS_ENGINE=edge → edge-tts com EDGE_TTS_VOICE', () => {
    process.env.TTS_ENGINE = 'edge';
    process.env.EDGE_TTS_VOICE = 'pt-PT-DuarteNeural';
    const cfg = resolveTtsConfig();
    assert.equal(cfg.provider, 'edge-tts');
    assert.equal(cfg.voice, 'pt-PT-DuarteNeural');
  });

  it('TTS_ENGINE=google → google com GOOGLE_TTS_VOICE e SPEECH_RATE', () => {
    process.env.TTS_ENGINE = 'google';
    process.env.GOOGLE_TTS_VOICE = 'pt-PT-Neural2-A';
    process.env.SPEECH_RATE = '1.1';
    const cfg = resolveTtsConfig();
    assert.equal(cfg.provider, 'google');
    assert.equal(cfg.voice, 'pt-PT-Neural2-A');
    assert.equal(cfg.rate, 1.1);
  });

  it('TTS_ENGINE inválido → ApiError 500 em pt-PT', () => {
    process.env.TTS_ENGINE = 'elevenlabs';
    assert.throws(() => resolveTtsConfig(), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.httpStatus, 500);
      assert.match(err.message, /TTS_ENGINE/);
      return true;
    });
  });

  it('SPEECH_RATE inválido → ApiError 500 em pt-PT', () => {
    process.env.SPEECH_RATE = 'rápido';
    assert.throws(() => resolveTtsConfig(), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.match(err.message, /SPEECH_RATE/);
      return true;
    });
  });
});
