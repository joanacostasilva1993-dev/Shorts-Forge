/**
 * Renderer-agnostic frame descriptors.
 *
 * buildFrames turns a (re-timed) Spec into one FrameDescriptor per
 * segment. It is pure: no I/O, no rendering, no timing invention —
 * durations come from actualDurationSec (measured in Phase B) falling
 * back to targetDurationSec, and caption timing comes from the real
 * TTS word timestamps.
 */
import type { Spec } from '@shorts-forge/shared';
import { buildCues, renderCaptionHtml, type CaptionCue } from './captions.js';
import { getTemplate, type BrandTemplate } from './templates.js';

/** Visual background of a frame. */
export type FrameBackground =
  | { kind: 'broll'; url: string }
  | { kind: 'color'; color: string };

/**
 * Renderer-agnostic description of one video shot.
 * This interface is FINAL — renderers (Hyperframes adapter, preview)
 * build on it without changes.
 */
export interface FrameDescriptor {
  /** Segment id this frame renders (e.g. "seg-01"). */
  segmentId: string;
  /** Shot duration in seconds: actualDurationSec ?? targetDurationSec. */
  durationSec: number;
  /** Background: resolved B-roll clip, or the template color as fallback. */
  background: FrameBackground;
  /**
   * Caption HTML for a time `t` (seconds, relative to the START of this
   * segment). Karaoke classes (`active`/`upcoming`) are derived from the
   * real word timestamps.
   */
  captionHtmlAt: (t: number) => string;
}

export interface BuiltFrames {
  frames: FrameDescriptor[];
  template: BrandTemplate;
  /** Total video duration in seconds (sum of frame durations). */
  totalDurationSec: number;
}

/**
 * Builds one FrameDescriptor per segment of the spec.
 * @throws when the template id is unknown (via getTemplate).
 */
export function buildFrames(spec: Spec, templateId: string): BuiltFrames {
  const template = getTemplate(templateId);
  let offset = 0;
  const frames: FrameDescriptor[] = spec.segments.map((segment) => {
    const durationSec = segment.actualDurationSec ?? segment.targetDurationSec;
    const cues: CaptionCue[] = buildCues(segment.tts?.words ?? []);
    const background: FrameBackground =
      segment.broll?.url != null && segment.broll.url !== ''
        ? { kind: 'broll', url: segment.broll.url }
        : { kind: 'color', color: template.colors.bg };
    const frame: FrameDescriptor = {
      segmentId: segment.id,
      durationSec,
      background,
      captionHtmlAt: (t: number) => renderCaptionHtml(cues, t, template),
    };
    offset += durationSec;
    return frame;
  });
  return { frames, template, totalDurationSec: offset };
}
