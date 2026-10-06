/**
 * Resolves the TTS voice configuration from the environment.
 *
 * Source of truth: `.env.example` (TTS_ENGINE, KOKORO_VOICE, EDGE_TTS_VOICE,
 * GOOGLE_TTS_VOICE, SPEECH_RATE). Mapping from the UI `TtsEngine`:
 * kokoro → 'kokoro', edge → 'edge-tts', google → 'google'.
 *
 * An empty `voice` means "use the TTS service's own default voice" — the
 * Python service (Fase 2) owns its catalog of voices; the pipeline only
 * overrides when the user configured one explicitly.
 *
 * NOTE (Fase 3 — i18n): Phase B no longer calls this directly. It uses
 * `resolveTtsForJob()` (voiceCatalog.ts), which layers the job language's
 * catalog default under these env overrides: explicit UI choice > env >
 * catalog default. This function remains as the env-only building block.
 */

import { ApiError } from './jobs.js';
import type { TtsProvider } from './pythonBridge.js';

export interface TtsConfig {
  provider: TtsProvider;
  /** Voice identifier; '' = the service's default voice. */
  voice: string;
  /** Speech-rate multiplier; 1.0 = normal. */
  rate: number;
}

const VALID_ENGINES: Record<string, TtsProvider> = {
  kokoro: 'kokoro',
  edge: 'edge-tts',
  'edge-tts': 'edge-tts',
  google: 'google',
};

/** Resolves the TTS config; throws ApiError(500) on invalid configuration. */
export function resolveTtsConfig(): TtsConfig {
  const raw = (process.env.TTS_ENGINE ?? 'kokoro').trim().toLowerCase();
  const provider = VALID_ENGINES[raw];
  if (!provider) {
    throw new ApiError(
      'invalid_tts_config',
      500,
      `Configuração de TTS inválida: TTS_ENGINE="${raw}" (esperado: kokoro, edge-tts ou google).`,
    );
  }

  const voice =
    provider === 'kokoro'
      ? (process.env.KOKORO_VOICE ?? '').trim()
      : provider === 'edge-tts'
        ? (process.env.EDGE_TTS_VOICE ?? '').trim()
        : (process.env.GOOGLE_TTS_VOICE ?? '').trim();

  const rateRaw = (process.env.SPEECH_RATE ?? '1.0').trim();
  const rate = Number(rateRaw);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new ApiError(
      'invalid_tts_config',
      500,
      `Configuração de TTS inválida: SPEECH_RATE="${rateRaw}" tem de ser um número positivo.`,
    );
  }

  return { provider, voice, rate };
}
