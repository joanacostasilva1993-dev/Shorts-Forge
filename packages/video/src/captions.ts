/**
 * Karaoke caption engine.
 *
 * Core rule: every word highlight is driven by REAL word timestamps
 * (from TTS in Phase B, or from transcription for audio inputs).
 * Nothing here estimates, interpolates or fakes timing.
 */
import type { Word } from '@shorts-forge/shared';
import type { BrandTemplate } from './templates.js';

/** One word with validated timing, in seconds. */
export interface CaptionCue {
  word: string;
  start: number;
  end: number;
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
