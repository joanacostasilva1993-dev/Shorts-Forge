/**
 * @shorts-forge/video — public API.
 *
 * Templates & captions: pure logic, fully tested.
 * Hyperframes adapter: real (composition HTML + CLI spawn); lint gate
 * before expensive renders.
 * Per-segment rendering (render.ts): buildSegmentFrame →
 * buildSegmentComposition → lint → renderFrames → one MP4 clip per
 * segment; renderJobSegments for a whole spec; renderPreviewMp4 for the
 * fast low-res UI preview.
 * FFmpeg assembly: argument builder + hwaccel detection are real;
 * assemble() executes the real assembly; assembleJob() is the Phase B
 * entry point (re-timed segments + clips + TTS audio → final.mp4).
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
  getCaptionBudget,
  wrapCaptionLines,
  captionFontSizePx,
  captionBoxFor,
  hookTopFrac,
} from './captions.js';
export type { CaptionCue, CaptionBudget, CaptionSafeBox } from './captions.js';

export { buildFrames, buildFrameDescriptor } from './frames.js';
export type { FrameDescriptor, FrameBackground, BuiltFrames } from './frames.js';

export {
  listPresets,
  presetIds,
  getPreset,
  isPlatformPresetId,
  defaultPresetForFormat,
  resolvePreset,
  safeAreaPx,
} from './presets.js';
export type { PlatformPreset } from './presets.js';

export {
  buildCompositionHtml,
  renderFrames,
  lintCompositionHtml,
  parseCaptionWords,
  HOOK_SHOW_SEC,
} from './hyperframesAdapter.js';
export type {
  CompositionOptions,
  RenderFramesOptions,
  ParsedCaptionWord,
} from './hyperframesAdapter.js';

export {
  buildSegmentFrame,
  buildSegmentComposition,
  renderSegmentClip,
  renderJobSegments,
  renderPreviewMp4,
  renderJobVideo,
  createVideoRenderer,
  resolveBrollAssetUrl,
  canvasFor,
  canvasForPreset,
  renderTargetFor,
  previewCanvasFor,
} from './render.js';
export type {
  SegmentRenderOptions,
  PreviewRenderOptions,
  JobVideoOptions,
  VideoRenderer,
  LintGate,
} from './render.js';

export { writePreviewHtml } from './preview.js';

export {
  resolveBroll,
  resolveBrollForSegments,
  searchPexels,
  searchPixabay,
  searchPexelsMulti,
  searchPixabayMulti,
  selectBestCandidate,
  scoreCandidate,
  buildSearchQuery,
  buildQueryVariants,
  tokensFromPageUrl,
  buildSmoothLoopArgs,
  buildFreezeFrameArgs,
  fitShortClip,
  cachePathFor,
  defaultCacheDir,
  downloadToCache,
  ensureKenBurnsClip,
  ensureTemplateClip,
  ffmpegAvailable,
  kenBurnsVariant,
  clipIdForKenBurns,
  buildGradientStillArgs,
  buildKenBurnsArgs,
  buildTemplateClipArgs,
  UsedClipRegistry,
} from './broll.js';
export type {
  BrollProvider,
  ShortClipStrategy,
  BrollCandidate,
  CandidateScore,
  KenBurnsMotion,
  ResolvedBroll,
  ResolveBrollOptions,
  SearchQueryOptions,
  FitShortClipDeps,
} from './broll.js';

export { detectHwAccel, buildAssembleArgs, assemble, assembleJob } from './ffmpeg.js';
export type { HwAccel, AssembleOptions, AssembleJobInput } from './ffmpeg.js';
