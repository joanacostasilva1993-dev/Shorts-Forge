/**
 * @shorts-forge/video — public API.
 *
 * Templates & captions: pure logic, fully tested.
 * Hyperframes adapter: real (composition HTML + CLI spawn).
 * FFmpeg assembly: argument builder + hwaccel detection are real;
 * the assemble() executor is a Phase 4 stub.
 */
export { getTemplate, listTemplateIds } from './templates.js';
export type { BrandTemplate, CaptionPosition } from './templates.js';

export {
  buildCues,
  activeCue,
  escapeHtml,
  renderCaptionHtml,
  renderCaptionHtmlWithActive,
  parseCueTimings,
} from './captions.js';
export type { CaptionCue } from './captions.js';

export { buildFrames } from './frames.js';
export type { FrameDescriptor, FrameBackground, BuiltFrames } from './frames.js';

export {
  buildCompositionHtml,
  renderFrames,
  lintCompositionHtml,
  parseCaptionWords,
} from './hyperframesAdapter.js';
export type {
  CompositionOptions,
  RenderFramesOptions,
  ParsedCaptionWord,
} from './hyperframesAdapter.js';

export { writePreviewHtml } from './preview.js';

export { detectHwAccel, buildAssembleArgs, assemble } from './ffmpeg.js';
export type { HwAccel, AssembleOptions } from './ffmpeg.js';
