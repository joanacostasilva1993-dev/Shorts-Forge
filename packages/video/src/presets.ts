/**
 * Platform presets for shorts-forge.
 *
 * A preset bundles everything a render target needs beyond the raw
 * aspect ratio: resolution, recommended max duration, caption safe-area
 * insets (to avoid platform UI overlays), loudness target and platform
 * quirks. Every preset implies a `VideoFormat` — the API's precedence
 * rule is: an explicit `preset` wins over `format` (see docs/platforms.md).
 *
 * IMPORTANT — the numbers below are DOCUMENTED SENSIBLE VALUES, not
 * platform-certified specs. They come from the well-known, stable layout
 * facts of each app (vertical video has an action rail on the right and a
 * progress/title zone at the bottom; horizontal video has a bottom player
 * bar) plus conservative margins. If a platform redesigns its player,
 * update the safe areas here — everything downstream (caption CSS,
 * preview, docs) follows automatically.
 */
import type {
  PlatformPresetId,
  SafeArea,
  VideoFormat,
} from '@shorts-forge/shared';

export interface PlatformPreset {
  /** Machine id, e.g. 'tiktok'. */
  id: PlatformPresetId;
  /** Implied aspect ratio. */
  format: VideoFormat;
  /** Display name (pt-PT). */
  label: string;
  /** One-line description (pt-PT). */
  description: string;
  /** Render canvas width in px. */
  width: number;
  /** Render canvas height in px. */
  height: number;
  /**
   * Recommended max duration in seconds, or null when there is no
   * practical cap for this tool (YouTube long-form).
   */
  maxRecommendedDurationSec: number | null;
  /** Caption safe-area insets, as fractions of the canvas. */
  safeArea: SafeArea;
  /** Integrated loudness target, in LUFS. */
  loudnessLufs: number;
  /** Platform quirks worth knowing (pt-PT). */
  quirks: string[];
}

const THREE_MINUTES = 180;

const PRESETS: Record<PlatformPresetId, PlatformPreset> = {
  tiktok: {
    id: 'tiktok',
    format: '9:16',
    label: 'TikTok',
    description:
      'Vertical 1080×1920. Margens maiores à direita (rail de ações) e em baixo (progresso + descrição).',
    width: 1080,
    height: 1920,
    maxRecommendedDurationSec: THREE_MINUTES,
    safeArea: { top: 0.1, right: 0.15, bottom: 0.16, left: 0.06 },
    loudnessLufs: -14,
    quirks: [
      'O rail de ações (gosto, comentários, partilha) ocupa a faixa direita — manter legendas e texto à esquerda do centro.',
      'A barra de progresso e a descrição do vídeo ficam em baixo; as legendas sobem para cima dessa zona.',
      'Vídeos com legendas queimadas têm melhor retenção com o som desligado.',
    ],
  },
  'youtube-shorts': {
    id: 'youtube-shorts',
    format: '9:16',
    label: 'YouTube Shorts',
    description:
      'Vertical 1080×1920, até 3 minutos. O formato omisso do shorts-forge.',
    width: 1080,
    height: 1920,
    maxRecommendedDurationSec: THREE_MINUTES,
    safeArea: { top: 0.08, right: 0.08, bottom: 0.14, left: 0.06 },
    loudnessLufs: -14,
    quirks: [
      'Para contar como Short, o vídeo tem de ter 3 minutos ou menos e ser vertical.',
      'O título e o nome do canal sobrepõem-se à zona inferior — legendas acima dessa faixa.',
      'O YouTube normaliza o áudio para cerca de −14 LUFS.',
    ],
  },
  'youtube-long': {
    id: 'youtube-long',
    format: '16:9',
    label: 'YouTube (vídeo longo)',
    description:
      'Horizontal 1920×1080, sem limite prático de duração. Área segura mais generosa.',
    width: 1920,
    height: 1080,
    maxRecommendedDurationSec: null,
    safeArea: { top: 0.08, right: 0.04, bottom: 0.12, left: 0.04 },
    loudnessLufs: -14,
    quirks: [
      'A barra do leitor ocupa a faixa inferior — legendas acima dela.',
      'A miniatura e os primeiros 30 segundos decidem a retenção.',
      'O YouTube normaliza o áudio para cerca de −14 LUFS.',
    ],
  },
  'instagram-reels': {
    id: 'instagram-reels',
    format: '9:16',
    label: 'Instagram Reels',
    description:
      'Vertical 1080×1920, até 3 minutos. Zona de descrição larga em baixo.',
    width: 1080,
    height: 1920,
    maxRecommendedDurationSec: THREE_MINUTES,
    safeArea: { top: 0.1, right: 0.12, bottom: 0.18, left: 0.06 },
    loudnessLufs: -14,
    quirks: [
      'A descrição e os botões ocupam grande parte da zona inferior — a margem de baixo é a maior dos formatos verticais.',
      'O rail de ações (gosto, comentários, partilha) fica à direita.',
      'Reels favorecem legendas grandes e centradas dentro da área segura.',
    ],
  },
};

/** All preset ids. */
export function presetIds(): PlatformPresetId[] {
  return Object.keys(PRESETS) as PlatformPresetId[];
}

/** All presets, in display order. */
export function listPresets(): PlatformPreset[] {
  return presetIds().map((id) => PRESETS[id]!);
}

/** Type guard for values coming from the API / UI. */
export function isPlatformPresetId(id: unknown): id is PlatformPresetId {
  return typeof id === 'string' && id in PRESETS;
}

/**
 * Returns the preset for `id`.
 * @throws Error (pt-PT) when the id is unknown, listing the valid ids.
 */
export function getPreset(id: string): PlatformPreset {
  if (isPlatformPresetId(id)) return PRESETS[id];
  throw new Error(
    `Preset desconhecido: "${id}". Presets válidos: ${presetIds().join(', ')}.`,
  );
}

/**
 * Default preset for a bare aspect ratio (used when the API receives a
 * `format` without a `preset`): 9:16 → YouTube Shorts, 16:9 → YouTube
 * long-form.
 */
export function defaultPresetForFormat(format: VideoFormat): PlatformPreset {
  return format === '9:16' ? PRESETS['youtube-shorts']! : PRESETS['youtube-long']!;
}

/**
 * Resolves the effective preset for a render/API call.
 *
 * Precedence (documented in docs/platforms.md):
 *  1. an explicit, valid `presetId` wins — it implies its own format,
 *     even when a conflicting `format` is also given;
 *  2. otherwise a `format` alone maps to that aspect's default preset;
 *  3. with neither, the default is YouTube Shorts (9:16).
 *
 * @throws Error (pt-PT) when `presetId` is given but unknown.
 */
export function resolvePreset(
  presetId?: string | null,
  format?: VideoFormat | null,
): PlatformPreset {
  if (presetId !== undefined && presetId !== null && presetId !== '') {
    return getPreset(presetId);
  }
  return defaultPresetForFormat(format ?? '9:16');
}

/**
 * Safe-area insets in px for a concrete canvas size.
 * Pure and deterministic.
 */
export function safeAreaPx(
  preset: PlatformPreset,
  width: number,
  height: number,
): { top: number; right: number; bottom: number; left: number } {
  const s = preset.safeArea;
  return {
    top: Math.round(s.top * height),
    right: Math.round(s.right * width),
    bottom: Math.round(s.bottom * height),
    left: Math.round(s.left * width),
  };
}
