/**
 * Vista da UI sobre o catálogo de vozes (packages/tts/voices.catalog.json).
 *
 * O JSON é a fonte única de verdade — este módulo só o lê e expõe
 * helpers para o seletor de idioma (StepInput) e a lista de vozes
 * (StepVoice). Quando o backend estiver ligado, a UI pode trocar isto por
 * GET /api/voices sem mudar os componentes.
 */

import catalogJson from '../../../tts/voices.catalog.json';

export type TtsProvider = 'kokoro' | 'edge-tts' | 'google';

export interface CatalogVoice {
  provider: TtsProvider;
  voice: string;
  gender: 'female' | 'male' | 'unknown';
  verified: boolean;
  note?: string;
}

export interface LanguageEntry {
  tag: string;
  label: string;
  whisperLang: string;
  defaultProvider: TtsProvider;
  defaultVoice: string;
  voices: CatalogVoice[];
  fallbackChain: { provider: TtsProvider; voice: string }[];
}

interface Catalog {
  version: number;
  providerDefaults: Record<TtsProvider, string>;
  languages: LanguageEntry[];
}

const catalog = catalogJson as unknown as Catalog;

/** Idiomas oferecidos no seletor, pela ordem do catálogo. */
export function supportedLanguages(): { tag: string; label: string }[] {
  return catalog.languages.map((l) => ({ tag: l.tag, label: l.label }));
}

/** Entrada do catálogo para um idioma (lança se desconhecido). */
export function languageEntry(tag: string): LanguageEntry {
  const entry = catalog.languages.find((l) => l.tag === tag);
  if (!entry) throw new Error(`Idioma não suportado: "${tag}".`);
  return entry;
}

/** Vozes para o seletor, na ordem do catálogo (omissão primeiro). */
export function voicesForLanguage(tag: string): CatalogVoice[] {
  return languageEntry(tag).voices;
}

/** Voz omissa para um idioma: { provider, voice }. */
export function defaultVoiceFor(tag: string): { provider: TtsProvider; voice: string } {
  const entry = languageEntry(tag);
  return { provider: entry.defaultProvider, voice: entry.defaultVoice };
}

/** Rótulo curto do provider para a UI. */
export function providerLabel(provider: TtsProvider): string {
  return provider === 'kokoro'
    ? 'Kokoro (local)'
    : provider === 'edge-tts'
      ? 'Edge-TTS'
      : 'Google Cloud TTS';
}
