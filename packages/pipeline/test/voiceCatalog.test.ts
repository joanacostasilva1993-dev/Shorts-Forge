/**
 * Tests for voiceCatalog.ts — language-aware TTS voice resolution.
 * Pure unit tests over packages/tts/voices.catalog.json; no network.
 * Run: npm test (tsc → node --test dist/test)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadVoiceCatalog,
  resetVoiceCatalogCache,
  supportedLanguages,
  isSupportedLanguage,
  getLanguageEntry,
  whisperLanguageCode,
  resolveTtsForJob,
} from '../src/voiceCatalog.js';

const ENV_KEYS = [
  'TTS_ENGINE',
  'KOKORO_VOICE',
  'EDGE_TTS_VOICE',
  'GOOGLE_TTS_VOICE',
  'SPEECH_RATE',
  'SHORTS_FORGE_ROOT',
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  resetVoiceCatalogCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetVoiceCatalogCache();
});

describe('voice catalog loading', () => {
  it('loads the shared catalog with the four supported languages', () => {
    const catalog = loadVoiceCatalog();
    assert.equal(catalog.version, 1);
    const tags = supportedLanguages().map((l) => l.tag);
    assert.deepEqual(tags, ['pt-PT', 'pt-BR', 'en', 'fr']);
  });

  it('labels are in pt-PT', () => {
    const labels = Object.fromEntries(supportedLanguages().map((l) => [l.tag, l.label]));
    assert.equal(labels['pt-PT'], 'Português (Portugal)');
    assert.equal(labels['pt-BR'], 'Português (Brasil)');
  });

  it('isSupportedLanguage / getLanguageEntry agree', () => {
    assert.equal(isSupportedLanguage('pt-PT'), true);
    assert.equal(isSupportedLanguage('de'), false);
    assert.equal(getLanguageEntry('fr').whisperLang, 'fr');
    assert.throws(() => getLanguageEntry('de'), /não suportado/);
  });

  it('whisperLanguageCode maps tags to faster-whisper codes', () => {
    assert.equal(whisperLanguageCode('pt-PT'), 'pt');
    assert.equal(whisperLanguageCode('pt-BR'), 'pt');
    assert.equal(whisperLanguageCode('en'), 'en');
    assert.equal(whisperLanguageCode('fr'), 'fr');
  });
});

describe('catalog defaults per language', () => {
  it('pt-PT defaults to Edge-TTS DuarteNeural (european accent)', () => {
    const r = resolveTtsForJob({ language: 'pt-PT' });
    assert.equal(r.provider, 'edge-tts');
    assert.equal(r.voice, 'pt-PT-DuarteNeural');
    assert.equal(r.rate, 1.0);
  });

  it('pt-BR defaults to Kokoro pf_dora (Joana loved the Kokoro voices)', () => {
    const r = resolveTtsForJob({ language: 'pt-BR' });
    assert.equal(r.provider, 'kokoro');
    assert.equal(r.voice, 'pf_dora');
  });

  it('en defaults to Kokoro af_heart', () => {
    const r = resolveTtsForJob({ language: 'en' });
    assert.equal(r.provider, 'kokoro');
    assert.equal(r.voice, 'af_heart');
  });

  it('fr defaults to Kokoro ff_siwis (only French voice in Kokoro-82M)', () => {
    const r = resolveTtsForJob({ language: 'fr' });
    assert.equal(r.provider, 'kokoro');
    assert.equal(r.voice, 'ff_siwis');
  });

  it('each language exposes an ordered fallback chain starting at its default', () => {
    for (const tag of ['pt-PT', 'pt-BR', 'en', 'fr']) {
      const entry = getLanguageEntry(tag);
      assert.ok(entry.fallbackChain.length >= 2, `${tag}: chain too short`);
      assert.deepEqual(entry.fallbackChain[0], {
        provider: entry.defaultProvider,
        voice: entry.defaultVoice,
      });
    }
  });

  it('French chain offers Edge-TTS DeniseNeural as the network fallback', () => {
    const chain = getLanguageEntry('fr').fallbackChain;
    assert.ok(
      chain.some((c) => c.provider === 'edge-tts' && c.voice === 'fr-FR-DeniseNeural'),
      'fr-FR-DeniseNeural deve estar na cadeia de fallback do francês',
    );
  });
});

describe('resolveTtsForJob precedence', () => {
  it('explicit UI voice wins over everything', () => {
    process.env.TTS_ENGINE = 'google';
    process.env.GOOGLE_TTS_VOICE = 'pt-PT-Neural2-A';
    const r = resolveTtsForJob({ language: 'pt-PT', engine: 'kokoro', voice: 'pm_alex' });
    assert.equal(r.provider, 'kokoro');
    assert.equal(r.voice, 'pm_alex');
  });

  it('explicit UI engine (no voice) resolves the catalog voice for that provider', () => {
    const r = resolveTtsForJob({ language: 'pt-PT', engine: 'kokoro' });
    assert.equal(r.provider, 'kokoro');
    assert.equal(r.voice, 'pf_dora'); // first kokoro voice in the pt-PT chain
  });

  it('env TTS_ENGINE overrides the catalog default provider', () => {
    process.env.TTS_ENGINE = 'kokoro';
    const r = resolveTtsForJob({ language: 'pt-PT' });
    assert.equal(r.provider, 'kokoro');
    assert.equal(r.voice, 'pf_dora');
  });

  it('env provider voice overrides the catalog voice', () => {
    process.env.EDGE_TTS_VOICE = 'pt-PT-RaquelNeural';
    const r = resolveTtsForJob({ language: 'pt-PT' });
    assert.equal(r.provider, 'edge-tts');
    assert.equal(r.voice, 'pt-PT-RaquelNeural');
  });

  it('engine aliases: "edge" maps to "edge-tts"', () => {
    const r = resolveTtsForJob({ language: 'en', engine: 'edge' });
    assert.equal(r.provider, 'edge-tts');
    assert.equal(r.voice, 'en-US-AriaNeural');
  });

  it('invalid engine/engine env throws a clear error', () => {
    assert.throws(() => resolveTtsForJob({ language: 'en', engine: 'watson' }), /Motor de TTS inválido/);
    process.env.TTS_ENGINE = 'watson';
    assert.throws(() => resolveTtsForJob({ language: 'en' }), /TTS_ENGINE/);
  });

  it('SPEECH_RATE is validated', () => {
    process.env.SPEECH_RATE = '1.2';
    assert.equal(resolveTtsForJob({ language: 'en' }).rate, 1.2);
    process.env.SPEECH_RATE = 'banana';
    assert.throws(() => resolveTtsForJob({ language: 'en' }), /SPEECH_RATE/);
  });

  it('unknown language throws unsupported_language', () => {
    assert.throws(() => resolveTtsForJob({ language: 'de' }), /não suportado/);
  });
});
