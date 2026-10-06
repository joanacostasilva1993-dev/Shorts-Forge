/**
 * Language-aware TTS voice resolution (Fase 3 — i18n).
 *
 * Single source of truth: `packages/tts/voices.catalog.json` (pure data,
 * shared with the Python TTS service and the UI). This module is the
 * TypeScript view over that catalog: it loads it once, validates its
 * shape, and resolves the (provider, voice) pair for a job from
 * (language, explicit engine/voice choice).
 *
 * WHY HERE (and not hardcoded in ttsConfig.ts): the catalog is data, not
 * code — adding a language or swapping a default voice is a JSON edit,
 * reviewed in one place, with no if-statements to touch. The Python
 * service reads the same file (packages/tts/service/voices_catalog.py),
 * so both runtimes agree on defaults.
 *
 * Precedence for a job (most specific wins):
 *   1. explicit per-job choice from the UI (StepVoice → POST /api/jobs `tts`)
 *   2. environment overrides (TTS_ENGINE / KOKORO_VOICE / EDGE_TTS_VOICE /
 *      GOOGLE_TTS_VOICE / SPEECH_RATE) — machine-level defaults
 *   3. catalog default for the job's language
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from './jobs.js';
import type { TtsProvider } from './pythonBridge.js';

/** One voice entry in the catalog. */
export interface CatalogVoice {
  provider: TtsProvider;
  voice: string;
  gender: 'female' | 'male' | 'unknown';
  /** True when the name was confirmed live (in this sandbox); false = from the provider's public list, verify on Joana's PC. */
  verified: boolean;
  note?: string;
}

/** Everything the pipeline knows about one supported narration language. */
export interface LanguageEntry {
  /** BCP-47-ish tag, e.g. "pt-PT". */
  tag: string;
  /** UI label in pt-PT, e.g. "Português (Portugal)". */
  label: string;
  /** faster-whisper language code for the transcription hint, e.g. "pt". */
  whisperLang: string;
  defaultProvider: TtsProvider;
  defaultVoice: string;
  /** Ordered candidates shown in the UI voice picker. */
  voices: CatalogVoice[];
  /** Ordered (provider, voice) fallback chain for this language. */
  fallbackChain: { provider: TtsProvider; voice: string }[];
}

/** Raw shape of packages/tts/voices.catalog.json. */
export interface VoiceCatalogData {
  version: number;
  providerDefaults: Record<TtsProvider, string>;
  languages: LanguageEntry[];
}

/** Resolved TTS plan for one job. */
export interface ResolvedJobTts {
  provider: TtsProvider;
  voice: string;
  rate: number;
  /** The language's full fallback chain (informational; the Python service also falls back across providers). */
  chain: { provider: TtsProvider; voice: string }[];
}

const VALID_PROVIDERS: Record<string, TtsProvider> = {
  kokoro: 'kokoro',
  edge: 'edge-tts',
  'edge-tts': 'edge-tts',
  google: 'google',
};

const PROVIDER_VOICE_ENV: Record<TtsProvider, string> = {
  kokoro: 'KOKORO_VOICE',
  'edge-tts': 'EDGE_TTS_VOICE',
  google: 'GOOGLE_TTS_VOICE',
};

/** Locate packages/tts/voices.catalog.json from this module's directory. */
function findCatalogPath(): string {
  const override = process.env.SHORTS_FORGE_ROOT;
  if (override) {
    const p = join(override, 'packages', 'tts', 'voices.catalog.json');
    if (existsSync(p)) return p;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  let dir: string | undefined = here;
  while (dir) {
    const candidate = join(dir, 'packages', 'tts', 'voices.catalog.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Catálogo de vozes não encontrado (packages/tts/voices.catalog.json). ' +
      'Define SHORTS_FORGE_ROOT ou corre a partir do repo shorts-forge.',
  );
}

function isTtsProvider(v: unknown): v is TtsProvider {
  return v === 'kokoro' || v === 'edge-tts' || v === 'google';
}

function assertCatalogShape(data: unknown): asserts data is VoiceCatalogData {
  if (typeof data !== 'object' || data === null) throw new Error('catálogo de vozes inválido (não é um objeto)');
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d['languages']) || d['languages'].length === 0) {
    throw new Error('catálogo de vozes inválido (languages vazio)');
  }
  for (const lang of d['languages'] as unknown[]) {
    const l = lang as Record<string, unknown>;
    if (typeof l['tag'] !== 'string' || typeof l['defaultVoice'] !== 'string' || !isTtsProvider(l['defaultProvider'])) {
      throw new Error('catálogo de vozes inválido (entrada de idioma malformada)');
    }
    if (!Array.isArray(l['fallbackChain']) || !Array.isArray(l['voices'])) {
      throw new Error(`catálogo de vozes inválido (idioma "${l['tag']}" sem voices/fallbackChain)`);
    }
  }
  const pd = d['providerDefaults'] as Record<string, unknown> | undefined;
  for (const p of ['kokoro', 'edge-tts', 'google'] as const) {
    if (typeof pd?.[p] !== 'string') throw new Error('catálogo de vozes inválido (providerDefaults incompleto)');
  }
}

let cached: VoiceCatalogData | null = null;

/** Loads (and caches) the voice catalog. Throws on missing/invalid file. */
export function loadVoiceCatalog(): VoiceCatalogData {
  if (cached) return cached;
  const path = findCatalogPath();
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch (err) {
    throw new Error(
      `Não foi possível ler o catálogo de vozes (${path}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  assertCatalogShape(data);
  cached = data;
  return data;
}

/** Forgets the cached catalog (tests). */
export function resetVoiceCatalogCache(): void {
  cached = null;
}

/** Languages the UI offers, in catalog order. */
export function supportedLanguages(): { tag: string; label: string }[] {
  return loadVoiceCatalog().languages.map((l) => ({ tag: l.tag, label: l.label }));
}

/** True when `tag` is a supported narration language. */
export function isSupportedLanguage(tag: string): boolean {
  const t = tag.trim();
  return loadVoiceCatalog().languages.some((l) => l.tag === t);
}

/** The catalog entry for a language; throws ApiError(400) when unsupported. */
export function getLanguageEntry(tag: string): LanguageEntry {
  const t = tag.trim();
  const entry = loadVoiceCatalog().languages.find((l) => l.tag === t);
  if (!entry) {
    const supported = supportedLanguages()
      .map((l) => l.tag)
      .join(', ');
    throw new ApiError(
      'unsupported_language',
      400,
      `Idioma não suportado: "${t}". Idiomas suportados: ${supported}.`,
    );
  }
  return entry;
}

/** faster-whisper language code for a catalog language tag (e.g. "pt-PT" → "pt"). */
export function whisperLanguageCode(tag: string): string {
  return getLanguageEntry(tag).whisperLang;
}

function resolveEnvProvider(): TtsProvider | null {
  const raw = process.env.TTS_ENGINE;
  if (raw === undefined || raw.trim() === '') return null; // not set → catalog decides
  const provider = VALID_PROVIDERS[raw.trim().toLowerCase()];
  if (!provider) {
    throw new ApiError(
      'invalid_tts_config',
      500,
      `Configuração de TTS inválida: TTS_ENGINE="${raw}" (esperado: kokoro, edge-tts ou google).`,
    );
  }
  return provider;
}

function resolveEnvVoice(provider: TtsProvider): string | null {
  const raw = process.env[PROVIDER_VOICE_ENV[provider]];
  if (raw === undefined || raw.trim() === '') return null;
  return raw.trim();
}

function resolveRate(): number {
  const rateRaw = (process.env.SPEECH_RATE ?? '1.0').trim();
  const rate = Number(rateRaw);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new ApiError(
      'invalid_tts_config',
      500,
      `Configuração de TTS inválida: SPEECH_RATE="${rateRaw}" tem de ser um número positivo.`,
    );
  }
  return rate;
}

/**
 * Resolves the TTS (provider, voice, rate) for a job.
 *
 * @param language  job language tag — must be in the catalog.
 * @param engine    explicit engine from the UI (`ttsEngine`); overrides env + catalog.
 * @param voice     explicit voice from the UI; overrides env + catalog.
 */
export function resolveTtsForJob(opts: {
  language: string;
  engine?: string | undefined;
  voice?: string | undefined;
}): ResolvedJobTts {
  const entry = getLanguageEntry(opts.language);

  let provider: TtsProvider;
  if (opts.engine !== undefined && opts.engine.trim() !== '') {
    const p = VALID_PROVIDERS[opts.engine.trim().toLowerCase()];
    if (!p) {
      throw new ApiError(
        'invalid_tts_config',
        400,
        `Motor de TTS inválido: "${opts.engine}" (esperado: kokoro, edge ou google).`,
      );
    }
    provider = p;
  } else {
    provider = resolveEnvProvider() ?? entry.defaultProvider;
  }

  let voice: string;
  const explicitVoice = opts.voice?.trim();
  if (explicitVoice) {
    voice = explicitVoice;
  } else {
    voice = resolveEnvVoice(provider) ?? voiceForProvider(entry, provider);
  }

  return { provider, voice, rate: resolveRate(), chain: entry.fallbackChain };
}

/** Best catalog voice for (language, provider): default if it matches, else first listed, else chain fallback. */
function voiceForProvider(entry: LanguageEntry, provider: TtsProvider): string {
  const def = entry.fallbackChain[0];
  if (entry.defaultProvider === provider && entry.defaultVoice) return entry.defaultVoice;
  const listed = entry.voices.find((v) => v.provider === provider);
  if (listed) return listed.voice;
  const chained = entry.fallbackChain.find((c) => c.provider === provider);
  if (chained) return chained.voice;
  if (def) return def.voice;
  throw new ApiError(
    'invalid_tts_config',
    500,
    `O catálogo não tem voz "${provider}" para o idioma "${entry.tag}".`,
  );
}
