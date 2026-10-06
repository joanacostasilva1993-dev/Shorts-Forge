/**
 * Testes de contrato da Fase 3 (c) — catálogo de vozes por idioma.
 *
 * Verificam contra o que CORRE de verdade: `packages/pipeline/src/voiceCatalog.ts`
 * sobre `packages/tts/voices.catalog.json` (fonte única de verdade,
 * partilhada com o serviço Python e a UI).
 *
 * Contrato:
 *  - Quatro idiomas suportados, por esta ordem: pt-PT, pt-BR, en, fr.
 *  - Defaults por idioma (factos verificados no catálogo):
 *      pt-PT → edge-tts / pt-PT-DuarteNeural   (o Kokoro NÃO tem voz pt-PT)
 *      pt-BR → kokoro / pf_dora                (a voz que a Joana adorou)
 *      en    → kokoro / af_heart
 *      fr    → edge-tts / fr-FR-DeniseNeural   (decisão da Joana, 2026-10-06:
 *        a ff_siwis do Kokoro foi rejeitada — robótica, mistura sotaque
 *        pt com francês; fica só como último fallback local)
 *  - A cadeia de fallback começa sempre no idioma do job (nunca muda de
 *    idioma em silêncio no primeiro salto); a 1.ª entrada da cadeia é o
 *    default do idioma.
 *  - Precedência: escolha explícita da UI > env > default do catálogo.
 *  - Idioma desconhecido → ApiError 400 'unsupported_language' (pt-PT).
 *
 * O ambiente é controlado nos testes (as vars TTS_* são guardadas e
 * restauradas) para os defaults do catálogo serem testáveis.
 *
 * Correr: npm test (tsc → node --test dist/test)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadVoiceCatalog,
  supportedLanguages,
  isSupportedLanguage,
  getLanguageEntry,
  whisperLanguageCode,
  resolveTtsForJob,
  ApiError,
} from '../src/index.js';

const ENV_KEYS = ['TTS_ENGINE', 'KOKORO_VOICE', 'EDGE_TTS_VOICE', 'GOOGLE_TTS_VOICE', 'SPEECH_RATE'] as const;
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

describe('voice catalog — línguas suportadas', () => {
  it('quatro idiomas, por ordem: pt-PT, pt-BR, en, fr', () => {
    const langs = supportedLanguages();
    assert.deepEqual(
      langs.map((l) => l.tag),
      ['pt-PT', 'pt-BR', 'en', 'fr'],
    );
    for (const l of langs) assert.ok(l.label.length > 0, 'label em pt-PT para a UI');
  });

  it('isSupportedLanguage distingue suportados de desconhecidos', () => {
    assert.equal(isSupportedLanguage('pt-PT'), true);
    assert.equal(isSupportedLanguage('fr'), true);
    assert.equal(isSupportedLanguage('de'), false);
    assert.equal(isSupportedLanguage(''), false);
  });

  it('whisperLanguageCode mapeia para o hint do faster-whisper', () => {
    assert.equal(whisperLanguageCode('pt-PT'), 'pt');
    assert.equal(whisperLanguageCode('pt-BR'), 'pt');
    assert.equal(whisperLanguageCode('en'), 'en');
    assert.equal(whisperLanguageCode('fr'), 'fr');
  });
});

describe('voice catalog — defaults por idioma (sem env, sem override da UI)', () => {
  const EXPECTED: Record<string, { provider: string; voice: string }> = {
    'pt-PT': { provider: 'edge-tts', voice: 'pt-PT-DuarteNeural' },
    'pt-BR': { provider: 'kokoro', voice: 'pf_dora' },
    en: { provider: 'kokoro', voice: 'af_heart' },
    fr: { provider: 'edge-tts', voice: 'fr-FR-DeniseNeural' },
  };
  for (const [language, expected] of Object.entries(EXPECTED)) {
    it(`${language} → ${expected.provider} / ${expected.voice}`, () => {
      const resolved = resolveTtsForJob({ language });
      assert.equal(resolved.provider, expected.provider);
      assert.equal(resolved.voice, expected.voice);
      assert.equal(resolved.rate, 1.0);
    });
  }

  it('pt-PT NUNCA usa Kokoro por omissão (não há voz pt-PT no Kokoro)', () => {
    const resolved = resolveTtsForJob({ language: 'pt-PT' });
    assert.notEqual(resolved.provider, 'kokoro', 'Kokoro para pt-PT seria sotaque brasileiro silencioso');
  });

  it('a cadeia devolvida é a do catálogo e começa no idioma do job', () => {
    for (const { tag } of supportedLanguages()) {
      const entry = getLanguageEntry(tag);
      const resolved = resolveTtsForJob({ language: tag });
      assert.deepEqual(resolved.chain, entry.fallbackChain);
      assert.ok(resolved.chain.length >= 1);
      assert.equal(resolved.chain[0]?.provider, entry.defaultProvider);
      assert.equal(resolved.chain[0]?.voice, entry.defaultVoice);
    }
  });
});

describe('voice catalog — precedência (UI > env > catálogo)', () => {
  it('escolha explícita da UI vence tudo', () => {
    process.env.TTS_ENGINE = 'kokoro';
    const resolved = resolveTtsForJob({ language: 'pt-PT', engine: 'edge', voice: 'pt-PT-RaquelNeural' });
    assert.equal(resolved.provider, 'edge-tts');
    assert.equal(resolved.voice, 'pt-PT-RaquelNeural');
  });

  it('env vence o default do catálogo', () => {
    process.env.TTS_ENGINE = 'kokoro';
    process.env.KOKORO_VOICE = 'pm_alex';
    const resolved = resolveTtsForJob({ language: 'en' });
    assert.equal(resolved.provider, 'kokoro');
    assert.equal(resolved.voice, 'pm_alex');
  });

  it('SPEECH_RATE inválido → ApiError 500 em pt-PT', () => {
    process.env.SPEECH_RATE = 'zero';
    assert.throws(() => resolveTtsForJob({ language: 'pt-PT' }), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, 'invalid_tts_config');
      assert.equal(err.httpStatus, 500);
      return true;
    });
  });

  it('TTS_ENGINE inválido → ApiError 500 em pt-PT', () => {
    process.env.TTS_ENGINE = 'elevenlabs';
    assert.throws(() => resolveTtsForJob({ language: 'pt-PT' }), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, 'invalid_tts_config');
      return true;
    });
  });
});

describe('voice catalog — erros honestos', () => {
  it('idioma desconhecido → ApiError 400 unsupported_language (pt-PT)', () => {
    assert.throws(() => getLanguageEntry('de'), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, 'unsupported_language');
      assert.equal(err.httpStatus, 400);
      assert.ok(err.message.includes('de'), 'a mensagem diz qual o idioma');
      assert.ok(err.message.includes('pt-PT'), 'a mensagem lista os suportados');
      return true;
    });
  });

  it('resolveTtsForJob com idioma desconhecido → 400, nunca voz inventada', () => {
    assert.throws(() => resolveTtsForJob({ language: 'klingon' }), (err: unknown) => {
      assert.ok(err instanceof ApiError && err.code === 'unsupported_language');
      return true;
    });
  });
});

describe('voice catalog — integridade dos dados', () => {
  it('versão 1, quatro idiomas, todas as vozes nomeadas', () => {
    const catalog = loadVoiceCatalog();
    assert.equal(catalog.version, 1);
    assert.equal(catalog.languages.length, 4);
    for (const lang of catalog.languages) {
      assert.ok(lang.voices.length >= 1, `${lang.tag} tem vozes`);
      for (const v of lang.voices) {
        assert.ok(v.voice.length > 0, 'nome de voz não vazio');
        assert.ok(['kokoro', 'edge-tts', 'google'].includes(v.provider));
        assert.equal(typeof v.verified, 'boolean');
      }
      for (const c of lang.fallbackChain) {
        assert.ok(c.voice.length > 0 && c.provider.length > 0);
      }
    }
  });

  it('vozes "verified: false" existem (há verificação manual por fazer)', () => {
    const catalog = loadVoiceCatalog();
    const unverified = catalog.languages.flatMap((l) =>
      l.voices.filter((v) => !v.verified).map((v) => `${l.tag}/${v.voice}`),
    );
    assert.ok(
      unverified.length > 0,
      'esperavam-se vozes por verificar (fr-FR-*, en-US-*, pt-BR-*) — ver checklist manual no TEST_PLAN.md §15',
    );
    // As francesas do Edge-TTS têm de estar na lista de verificação manual.
    assert.ok(unverified.some((v) => v.includes('fr-FR-DeniseNeural')));
    assert.ok(unverified.some((v) => v.includes('fr-FR-HenriNeural')));
  });
});
