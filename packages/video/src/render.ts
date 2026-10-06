/**
 * Per-segment rendering orchestration for shorts-forge.
 *
 * Pipeline per segment: `buildSegmentFrame(segment, template)` (frame
 * descriptor with karaoke captions from the segment's REAL TTS word
 * timestamps, hook line and template styling) → `buildSegmentComposition`
 * (self-contained Hyperframes HTML) → `lintCompositionHtml` gate →
 * `renderFrames` (Hyperframes adapter) → one MP4 clip per segment.
 *
 * `renderJobSegments` renders every segment of a re-timed spec, in order;
 * `renderPreviewMp4` renders the whole spec once, at low resolution, for
 * the UI preview step. `renderJobVideo` chains segment rendering with
 * `assembleJob` (FFmpeg) into the final MP4.
 *
 * B-roll URL resolution (agreed shape: `Segment.broll` in
 * `@shorts-forge/shared`): prefers `localPath` when it exists on disk
 * (cached Pexels/Pixabay downloads, Ken Burns / template clips generated
 * by the B-roll engineer), then an http(s) `url`, then a local path in
 * `url`. Local paths become `file://` URLs so headless Chrome can load
 * them. Empty/missing → the template colour fallback (handled by
 * buildFrameDescriptor).
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Segment, Spec, VideoFormat, PlatformPresetId, SafeArea } from '@shorts-forge/shared';
import { buildFrameDescriptor, type FrameDescriptor } from './frames.js';
import {
  buildCompositionHtml,
  lintCompositionHtml,
  renderFrames,
  type CompositionOptions,
  type RenderFramesOptions,
} from './hyperframesAdapter.js';
import { getTemplate, type BrandTemplate } from './templates.js';
import { getPreset } from './presets.js';
import { assembleJob, type AssembleJobInput } from './ffmpeg.js';

/** Canvas per output format. */
export function canvasFor(format: VideoFormat): { width: number; height: number } {
  return format === '9:16' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

/** Canvas per platform preset. */
export function canvasForPreset(preset: PlatformPresetId): { width: number; height: number } {
  const p = getPreset(preset);
  return { width: p.width, height: p.height };
}

/**
 * Resolves the effective render target from `preset`/`format` options.
 * A given `preset` wins and implies its own format; otherwise the
 * explicit (or default) format drives the canvas with no safe area.
 */
export function renderTargetFor(opts: {
  preset?: PlatformPresetId | undefined;
  format?: VideoFormat | undefined;
}): { width: number; height: number; format: VideoFormat; safeArea: SafeArea | undefined } {
  if (opts.preset !== undefined) {
    const p = getPreset(opts.preset);
    return { width: p.width, height: p.height, format: p.format, safeArea: p.safeArea };
  }
  const format = opts.format ?? '9:16';
  const { width, height } = canvasFor(format);
  return { width, height, format, safeArea: undefined };
}

/** Low-res canvas for fast previews. */
export function previewCanvasFor(format: VideoFormat): { width: number; height: number } {
  return format === '9:16' ? { width: 360, height: 640 } : { width: 640, height: 360 };
}

function resolveTemplate(t: BrandTemplate | string | undefined): BrandTemplate {
  if (!t) return getTemplate('bold-social');
  return typeof t === 'string' ? getTemplate(t) : t;
}

/**
 * Resolves the best background asset URL for a segment's B-roll, for
 * consumption by headless Chrome. Returns null when there is no usable
 * asset (the caller keeps the template-colour fallback).
 */
export function resolveBrollAssetUrl(
  broll: NonNullable<Segment['broll']>,
): string | null {
  if (broll.localPath && existsSync(broll.localPath)) {
    return pathToFileURL(resolve(broll.localPath)).href;
  }
  const url = broll.url ?? '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url !== '' && existsSync(url)) {
    return pathToFileURL(resolve(url)).href;
  }
  return null;
}

/**
 * Builds the per-segment FrameDescriptor: durations from
 * actualDurationSec ?? targetDurationSec, karaoke captions from the
 * segment's real TTS word timestamps, hook line carried over, template
 * styling — with the B-roll asset URL resolved for the renderer.
 */
export function buildSegmentFrame(
  segment: Segment,
  template: BrandTemplate | string,
): FrameDescriptor {
  const t = resolveTemplate(template);
  const frame = buildFrameDescriptor(segment, t);
  if (segment.broll) {
    const assetUrl = resolveBrollAssetUrl(segment.broll);
    if (assetUrl) frame.background = { kind: 'broll', url: assetUrl };
  }
  return frame;
}

/**
 * Builds the self-contained Hyperframes composition HTML for ONE segment
 * (background + karaoke caption overlays + hook-line overlay, all in the
 * template's styling). Pure and deterministic.
 */
export function buildSegmentComposition(
  segment: Segment,
  template: BrandTemplate | string,
  opts: CompositionOptions,
): string {
  const t = resolveTemplate(template);
  const frame = buildSegmentFrame(segment, t);
  return buildCompositionHtml([frame], t, {
    ...opts,
    compositionId: opts.compositionId ?? `sf-${segment.id}`,
  });
}

/** Lint gate implementation: receives the composition HTML and a work dir. */
export type LintGate = (html: string, workDir: string) => { ok: boolean; output: string };

export interface SegmentRenderOptions {
  /** Directory for the per-segment MP4 clips (created when missing). */
  outDir: string;
  /** BrandTemplate or template id. Defaults to 'bold-social'. */
  template?: BrandTemplate | string | undefined;
  /** Output aspect. Defaults to '9:16'. Ignored when `preset` is given (preset wins). */
  format?: VideoFormat | undefined;
  /**
   * Platform preset (e.g. 'tiktok'). When given it implies the format,
   * drives the canvas resolution, applies the preset's caption safe area
   * and (in renderJobVideo) its loudness target.
   */
  preset?: PlatformPresetId | undefined;
  /** Frame rate. Defaults to 30. */
  fps?: number | undefined;
  /** Working dir for Hyperframes temp files (keep off small tmpfs mounts). */
  workDir?: string | undefined;
  /** Timeout per segment render in ms. Defaults to 10 minutes. */
  timeoutMs?: number | undefined;
  /**
   * The `lintCompositionHtml` gate before rendering. `true` (default) uses
   * the real gate; `false` skips it; a function injects a custom
   * implementation (tests). A composition that fails lint never reaches
   * the browser.
   */
  lint?: boolean | LintGate | undefined;
  /**
   * Directory redirected as TMPDIR for the hyperframes child process
   * (it requires ~1 GB free on os.tmpdir()). Defaults to
   * `<outDir>/.tmp`.
   */
  tmpDir?: string | undefined;
  /** Progress callback after each rendered segment. */
  onProgress?: ((done: number, total: number, segmentId: string) => void) | undefined;
}

/**
 * Renders ONE segment to an MP4 clip: build → lint gate → Hyperframes.
 * Returns the absolute clip path. Throws (in pt-PT) when the lint gate
 * fails or the render CLI fails — never a fake clip.
 */
export async function renderSegmentClip(
  segment: Segment,
  opts: SegmentRenderOptions & { outPath?: string },
): Promise<string> {
  const template = resolveTemplate(opts.template);
  const target = renderTargetFor(opts);
  const { width, height, safeArea } = target;
  const fps = opts.fps ?? 30;
  const compOpts: CompositionOptions = { width, height, fps };
  if (safeArea) compOpts.safeArea = safeArea;
  const html = buildSegmentComposition(segment, template, compOpts);

  const outPath = resolve(opts.outPath ?? join(resolve(opts.outDir), `${segment.id}.mp4`));
  const outDir = dirname(outPath);
  mkdirSync(outDir, { recursive: true });
  const workDir = resolve(opts.workDir ?? join(outDir, `.hf-${segment.id}-${Date.now()}`));

  if (opts.lint !== false) {
    const gate: LintGate = typeof opts.lint === 'function' ? opts.lint : lintCompositionHtml;
    const lint = gate(html, workDir);
    if (!lint.ok) {
      throw new Error(
        `renderSegmentClip: a composição do segmento "${segment.id}" chumbou no lint do Hyperframes — render abortado.\n` +
          lint.output.slice(-3000),
      );
    }
  }

  const tmpDir = resolve(opts.tmpDir ?? join(outDir, '.tmp'));
  mkdirSync(tmpDir, { recursive: true });

  const frame = buildSegmentFrame(segment, template);
  const renderOpts: RenderFramesOptions = {
    width,
    height,
    fps,
    outPath,
    template,
    workDir,
    prebuiltHtml: html,
    env: { TMPDIR: tmpDir },
  };
  if (opts.timeoutMs !== undefined) renderOpts.timeoutMs = opts.timeoutMs;
  return renderFrames([frame], renderOpts);
}

/**
 * Renders every segment of a (re-timed) spec to per-segment MP4 clips,
 * in order. Returns the absolute clip paths. Clips land in
 * `<outDir>/<segmentId>.mp4`.
 */
export async function renderJobSegments(
  spec: Spec,
  opts: SegmentRenderOptions,
): Promise<string[]> {
  const outDir = resolve(opts.outDir);
  mkdirSync(outDir, { recursive: true });
  const clips: string[] = [];
  const total = spec.segments.length;
  if (total === 0) throw new Error('renderJobSegments: a Spec não tem segmentos.');
  for (let i = 0; i < total; i++) {
    const segment = spec.segments[i]!;
    const clip = await renderSegmentClip(segment, {
      ...opts,
      outDir,
      outPath: join(outDir, `${segment.id}.mp4`),
    });
    clips.push(clip);
    opts.onProgress?.(i + 1, total, segment.id);
  }
  return clips;
}

export interface PreviewRenderOptions {
  /** BrandTemplate or template id. Defaults to 'bold-social'. */
  template?: BrandTemplate | string | undefined;
  /** Output aspect. Defaults to '9:16'. Ignored when `preset` is given (preset wins). */
  format?: VideoFormat | undefined;
  /**
   * Platform preset (e.g. 'tiktok'). When given it implies the format,
   * drives the canvas resolution and applies the preset's caption safe
   * area to the preview.
   */
  preset?: PlatformPresetId | undefined;
  /** Frame rate. Defaults to 30. */
  fps?: number | undefined;
  /** Timeout for the render CLI in ms. Defaults to 5 minutes. */
  timeoutMs?: number | undefined;
  /** Lint gate: true (default) = real `lintCompositionHtml`; false = skip; function = inject. */
  lint?: boolean | LintGate | undefined;
  /** TMPDIR redirection for the hyperframes child process. */
  tmpDir?: string | undefined;
  /** Working dir for Hyperframes temp files. */
  workDir?: string | undefined;
}

/**
 * Fast low-res preview of a whole spec: a single Hyperframes render at
 * 360x640 (9:16) or 640x360 (16:9) with a higher CRF. Used by
 * `GET /api/jobs/:id/preview`. Returns the absolute preview MP4 path.
 */
export async function renderPreviewMp4(
  spec: Spec,
  outPath: string,
  opts: PreviewRenderOptions = {},
): Promise<string> {
  const template = resolveTemplate(opts.template);
  const target = renderTargetFor(opts);
  const format = target.format;
  const { width, height } = previewCanvasFor(format);
  const fps = opts.fps ?? 30;
  const abs = resolve(outPath);
  mkdirSync(dirname(abs), { recursive: true });
  const workDir = resolve(opts.workDir ?? join(dirname(abs), `.hf-preview-${Date.now()}`));

  const frames = spec.segments.map((segment) => buildSegmentFrame(segment, template));
  if (frames.length === 0) throw new Error('renderPreviewMp4: a Spec não tem segmentos.');
  const compOpts: CompositionOptions = {
    width,
    height,
    fps,
    compositionId: 'sf-preview',
  };
  if (target.safeArea) compOpts.safeArea = target.safeArea;
  const html = buildCompositionHtml(frames, template, compOpts);

  if (opts.lint !== false) {
    const gate: LintGate = typeof opts.lint === 'function' ? opts.lint : lintCompositionHtml;
    const lint = gate(html, workDir);
    if (!lint.ok) {
      throw new Error(
        'renderPreviewMp4: a composição de preview chumbou no lint do Hyperframes.\n' +
          lint.output.slice(-3000),
      );
    }
  }

  const tmpDir = resolve(opts.tmpDir ?? join(dirname(abs), '.tmp'));
  mkdirSync(tmpDir, { recursive: true });

  return renderFrames(frames, {
    width,
    height,
    fps,
    outPath: abs,
    template,
    workDir,
    timeoutMs: opts.timeoutMs ?? 5 * 60 * 1000,
    prebuiltHtml: html,
    crf: 28,
    env: { TMPDIR: tmpDir },
  });
}

export interface JobVideoOptions {
  /** Per-job outputs dir: clips → `<outDir>/segments/`, final → `<outDir>/final.mp4`. */
  outDir: string;
  /** Output aspect. Defaults to '9:16'. Ignored when `preset` is given (preset wins). */
  format?: VideoFormat | undefined;
  /**
   * Platform preset (e.g. 'tiktok'). When given it implies the format,
   * drives the canvas resolution, applies the preset's caption safe area
   * and its loudness target in the final assembly.
   */
  preset?: PlatformPresetId | undefined;
  /** BrandTemplate or template id. Defaults to 'bold-social'. */
  template?: BrandTemplate | string | undefined;
  /** Optional background music track (ducked under narration). */
  musicPath?: string | undefined;
  /** Frame rate. Defaults to 30. */
  fps?: number | undefined;
  /** Progress callback: (doneSegments, totalSegments, message). */
  onProgress?: ((done: number, total: number, message: string) => void) | undefined;
}

/**
 * Full per-segment pipeline for one job: render every segment clip with
 * Hyperframes, then assemble the final timeline with FFmpeg
 * (`assembleJob` ← `buildAssembleArgs`). Returns the absolute path of
 * `<outDir>/final.mp4`.
 */
export async function renderJobVideo(spec: Spec, opts: JobVideoOptions): Promise<string> {
  const target = renderTargetFor(opts);
  const format = target.format;
  const preset = opts.preset !== undefined ? getPreset(opts.preset) : undefined;
  const outDir = resolve(opts.outDir);
  const total = spec.segments.length;
  if (total === 0) throw new Error('renderJobVideo: a Spec não tem segmentos.');

  opts.onProgress?.(0, total, 'A renderizar os segmentos do vídeo…');
  const segmentOpts: SegmentRenderOptions = {
    outDir: join(outDir, 'segments'),
    format,
    fps: opts.fps,
    onProgress: (done, totalSegs, segmentId) =>
      opts.onProgress?.(done, totalSegs, `Segmento ${done}/${totalSegs} renderizado (${segmentId}).`),
  };
  if (opts.template !== undefined) segmentOpts.template = opts.template;
  if (opts.preset !== undefined) segmentOpts.preset = opts.preset;
  const clips = await renderJobSegments(spec, segmentOpts);

  opts.onProgress?.(total, total, 'A montar o vídeo final (FFmpeg)…');
  const assembleInput: AssembleJobInput = {
    segments: spec.segments,
    segmentClips: clips,
    outDir,
    format,
    fps: opts.fps,
    onProgress: (message) => opts.onProgress?.(total, total, message),
  };
  if (opts.musicPath) assembleInput.musicPath = opts.musicPath;
  if (preset) assembleInput.loudnessLufs = preset.loudnessLufs;
  return assembleJob(assembleInput);
}

/**
 * `VideoRenderer` as proposed in ARCHITECTURE.md §4.5: renders a
 * (re-timed) spec to the final MP4, plus a fast low-res preview.
 */
export interface VideoRenderer {
  /** Renders the spec (already re-timed) to the final MP4. Returns outPath. */
  render(
    spec: Spec,
    opts: { outPath: string; template?: BrandTemplate | string; preset?: PlatformPresetId },
  ): Promise<string>;
  /** Fast low-res preview MP4 of the spec. Returns outPath. */
  preview(
    spec: Spec,
    opts: { outPath: string; template?: BrandTemplate | string; preset?: PlatformPresetId },
  ): Promise<string>;
}

/** Default `VideoRenderer`: per-segment Hyperframes + FFmpeg assembly. */
export function createVideoRenderer(format: VideoFormat = '9:16'): VideoRenderer {
  return {
    render: async (spec, opts) => {
      const outDir = dirname(resolve(opts.outPath));
      const renderOpts: JobVideoOptions = { outDir, format, template: opts.template };
      if (opts.preset !== undefined) renderOpts.preset = opts.preset;
      const finalPath = await renderJobVideo(spec, renderOpts);
      if (resolve(finalPath) !== resolve(opts.outPath)) {
        copyFileSync(finalPath, resolve(opts.outPath));
      }
      return resolve(opts.outPath);
    },
    preview: async (spec, opts) => {
      const previewOpts: PreviewRenderOptions = { format, template: opts.template };
      if (opts.preset !== undefined) previewOpts.preset = opts.preset;
      return renderPreviewMp4(spec, opts.outPath, previewOpts);
    },
  };
}
