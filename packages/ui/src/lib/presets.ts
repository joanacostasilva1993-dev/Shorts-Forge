/**
 * Display metadata for the platform preset picker (StepFormat).
 *
 * The canonical preset catalog (resolution, safe areas, loudness, quirks)
 * lives in `packages/video/src/presets.ts` and is enforced server-side —
 * this file only carries what the picker needs to render: pt-PT labels,
 * short descriptions and the implied format (sent alongside `preset` in
 * POST /api/jobs; the server gives `preset` precedence on conflict).
 * Keep the ids in sync with `PlatformPresetId` in @shorts-forge/shared.
 */
import type { PlatformPresetId, VideoFormat } from '@shorts-forge/shared';

export interface UiPreset {
  id: PlatformPresetId;
  /** Display label (pt-PT). */
  label: string;
  /** One-line description (pt-PT). */
  description: string;
  /** Aspect implied by the preset. */
  format: VideoFormat;
  /** Short spec line shown on the card (pt-PT). */
  meta: string;
}

export const UI_PRESETS: UiPreset[] = [
  {
    id: 'youtube-shorts',
    label: 'YouTube Shorts',
    description: 'O formato omisso: vertical, até 3 minutos.',
    format: '9:16',
    meta: '9:16 · 1080×1920 · até 3 min',
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    description: 'Vertical, até 3 minutos. Margens maiores à direita.',
    format: '9:16',
    meta: '9:16 · 1080×1920 · até 3 min',
  },
  {
    id: 'instagram-reels',
    label: 'Instagram Reels',
    description: 'Vertical, até 3 minutos. Descrição larga em baixo.',
    format: '9:16',
    meta: '9:16 · 1080×1920 · até 3 min',
  },
  {
    id: 'youtube-long',
    label: 'YouTube (vídeo longo)',
    description: 'Horizontal, sem limite prático de duração.',
    format: '16:9',
    meta: '16:9 · 1920×1080 · sem limite',
  },
];

/** The aspect implied by a preset (mirrors the server catalog). */
export function formatForPreset(id: PlatformPresetId): VideoFormat {
  return UI_PRESETS.find((p) => p.id === id)?.format ?? '9:16';
}
