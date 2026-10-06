/**
 * Karaoke caption engine.
 *
 * Core rule: every word highlight is driven by REAL word timestamps
 * (from TTS in Phase B, or from transcription for audio inputs).
 * Nothing here estimates, interpolates or fakes timing.
 */
import type { SafeArea, Word } from '@shorts-forge/shared';
import type { BrandTemplate, CaptionPosition } from './templates.js';

/** One word with validated timing, in seconds. */
export interface CaptionCue {
  word: string;
  start: number;
  end: number;
}

/**
 * Per-language caption budget.
 *
 * Why per language: the same content takes ~15–30% more characters in
 * Portuguese/French than in English (standard expansion rates used in
 * subtitling — cf. EBU-TT/Netflix timed-text guidance, where Latin-script
 * budgets sit around 32–42 chars/line for broadcast and Romance languages
 * are routinely set tighter). On a vertical phone canvas with big display
 * type we go tighter still, so Portuguese gets shorter lines than English
 * and a slightly smaller font to fit its longer words.
 */
export interface CaptionBudget {
  /** Max characters per caption line. */
  maxCharsPerLine: number;
  /** Max lines shown at once. */
  maxLines: number;
  /** Multiplier over the template's caption font size. */
  fontScale: number;
}

const CAPTION_BUDGETS: Record<string, CaptionBudget> = {
  pt: { maxCharsPerLine: 28, maxLines: 2, fontScale: 0.94 },
  en: { maxCharsPerLine: 34, maxLines: 2, fontScale: 1.0 },
  fr: { maxCharsPerLine: 30, maxLines: 2, fontScale: 0.96 },
};

const DEFAULT_BUDGET: CaptionBudget = CAPTION_BUDGETS['en']!;

/**
 * Returns the caption budget for a narration language tag ("pt-PT",
 * "pt-BR" → pt; "fr" → fr; "en" → en). Unknown tags fall back to English.
 */
export function getCaptionBudget(language: string): CaptionBudget {
  const base = language.trim().toLowerCase().split('-')[0] ?? '';
  return CAPTION_BUDGETS[base] ?? DEFAULT_BUDGET;
}

/**
 * Greedy word wrap of caption words into lines of at most
 * `maxCharsPerLine` characters. A single over-long word gets its own line
 * (never split mid-word). Pure and deterministic.
 */
export function wrapCaptionLines(words: string[], maxCharsPerLine: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const raw of words) {
    const word = raw.trim();
    if (!word) continue;
    if (!current) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= maxCharsPerLine) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Caption font size (px) for a template + narration language: the
 * template's reference size scaled by the language budget.
 */
export function captionFontSizePx(
  template: Pick<BrandTemplate, 'caption'>,
  language: string,
): number {
  return Math.max(1, Math.round(template.caption.fontSizePx * getCaptionBudget(language).fontScale));
}

/**
 * Normalizes raw words into cues: drops zero/negative-duration words and
 * words with non-finite timestamps. Order is preserved (pass-through).
 */
export function buildCues(words: Word[]): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (const w of words) {
    if (!w || typeof w.word !== 'string') continue;
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
    if (w.end <= w.start) continue; // zero-duration or inverted: drop
    cues.push({ word: w.word, start: w.start, end: w.end });
  }
  return cues;
}

/**
 * Index of the cue active at time `t` (start <= t < end), or -1 when no
 * cue covers `t` (before the first cue, in a gap, or after the last).
 */
export function activeCue(cues: CaptionCue[], t: number): number {
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!;
    if (t >= c.start && t < c.end) return i;
  }
  return -1;
}

/**
 * Caption box constraints inside a platform preset's safe area, as
 * fractions of the canvas. This is where the preset's safe-area margins
 * are applied to caption positioning: the caption box is clamped so it
 * never runs under platform UI overlays (action rails, progress bars).
 *
 * - `lower-third`: the bottom inset is the max of the template's default
 *   and the preset's bottom safe margin (e.g. TikTok's 16% pushes
 *   captions up from the progress/description zone);
 * - `center`: stays vertically centered, but the width shrinks so text
 *   never runs under the side action rails.
 */
export interface CaptionSafeBox {
  /** Bottom inset of the caption box, as a fraction of canvas height. */
  bottomFrac: number;
  /** Max caption width, as a fraction of canvas width. */
  maxWidthFrac: number;
}

export function captionBoxFor(
  position: CaptionPosition,
  safeArea: SafeArea,
  templateBottomFrac = 0.14,
  templateWidthFrac = 0.88,
): CaptionSafeBox {
  const maxWidthFrac = Math.min(
    templateWidthFrac,
    Math.max(0.1, 1 - safeArea.left - safeArea.right),
  );
  if (position === 'center') {
    return { bottomFrac: templateBottomFrac, maxWidthFrac };
  }
  return {
    bottomFrac: Math.max(templateBottomFrac, safeArea.bottom),
    maxWidthFrac,
  };
}

/**
 * Top inset for the hook-line overlay, as a fraction of canvas height:
 * the max of the template's default and the preset's top safe margin
 * (status bar / search buttons). Pure and deterministic.
 */
export function hookTopFrac(safeArea: SafeArea, templateTopFrac = 0.07): number {
  return Math.max(templateTopFrac, safeArea.top);
}

/** Escapes text for safe embedding in HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wordSpan(c: CaptionCue, cls: string): string {
  const duration = c.end - c.start;
  return `<span class="${cls}" data-start="${c.start}" data-duration="${duration}">${escapeHtml(c.word)}</span>`;
}

/**
 * Renders the caption as HTML: one `<span class="w …">` per word, each
 * carrying its real `data-start`/`data-duration` timestamps (Hyperframes
 * timing-attribute convention) so renderers can rebuild karaoke timing
 * without re-deriving it.
 *
 * NOTE for renderers: these per-word timing attributes are metadata for
 * parsing (see parseCueTimings). If you embed this HTML inside a timed
 * clip, strip or scope them — the Hyperframes runtime interprets timing
 * attributes on inner elements as composition-global time.
 *
 * Classes:
 *  - `active`   — the word spoken at time `t` (renderers style it with the
 *                 template's highlight color);
 *  - `upcoming` — words that start after `t` (not yet spoken);
 *  - (none)     — words already spoken.
 *
 * Pure and deterministic: same inputs → same string.
 */
export function renderCaptionHtml(
  cues: CaptionCue[],
  t: number,
  _template: BrandTemplate,
): string {
  const active = activeCue(cues, t);
  return cues
    .map((c, i) => {
      const cls = i === active ? 'w active' : c.start > t ? 'w upcoming' : 'w';
      return wordSpan(c, cls);
    })
    .join(' ');
}

/**
 * Same as renderCaptionHtml, but the active word is chosen by index
 * instead of by time. Used by renderers that build one overlay layer per
 * word (e.g. the Hyperframes adapter).
 */
export function renderCaptionHtmlWithActive(
  cues: CaptionCue[],
  activeIndex: number,
  _template: BrandTemplate,
): string {
  return cues
    .map((c, i) => wordSpan(c, i === activeIndex ? 'w active' : 'w'))
    .join(' ');
}

/**
 * Extracts cue timings from HTML produced by renderCaptionHtml /
 * renderCaptionHtmlWithActive. Lets renderers recover word-level timing
 * from a FrameDescriptor's captionHtmlAt(0) output without extra plumbing.
 */
export function parseCueTimings(captionHtml: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const re = /<span class="w[^"]*" data-start="([\d.eE+-]+)" data-duration="([\d.eE+-]+)">/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(captionHtml)) !== null) {
    const start = Number(m[1]);
    const duration = Number(m[2]);
    if (Number.isFinite(start) && Number.isFinite(duration) && duration > 0) {
      out.push({ start, end: start + duration });
    }
  }
  return out;
}
