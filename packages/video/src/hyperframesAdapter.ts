/**
 * Hyperframes adapter — REAL implementation.
 *
 * Hyperframes (v0.8.134, by HeyGen) renders plain HTML compositions to
 * video deterministically: a root element declares the canvas
 * (`data-composition-id`, `data-start`, `data-duration`, `data-width`,
 * `data-height`) and child `.clip` elements declare their timing via
 * `data-start`/`data-duration`. The renderer seeks frame-by-frame and
 * screenshots with headless Chrome — no `Date.now()`, no rAF, no playback.
 *
 * Karaoke strategy (deterministic, no JS timing): each segment becomes one
 * full-frame scene clip; on top of it, one flat sibling `.clip` overlay per
 * word, timed exactly to that word's real [start, end) timestamps. Every
 * overlay re-renders the same caption box with identical geometry, with
 * only that word highlighted — so the highlight lands pixel-perfect.
 * All overlays are flat siblings (never nested clips), which is the
 * structure the renderer documents. The composition carries
 * `data-no-timeline` because all motion is expressed with timed clips —
 * there is no JS timeline to register (the linter would otherwise make
 * every render wait ~45 s polling for one).
 *
 * What was verified here (2026-10-05):
 *  - `hyperframes render --help` documents `-c/--composition` + `-o/--output`
 *    (used by renderFrames via child_process spawn).
 *  - Composition generation is pure and unit-tested, including the
 *    caption-HTML → word-timing round-trip.
 * What still needs Phase 3/4 validation on a machine with the bundled
 * browser: `hyperframes lint` on a generated composition and one real
 * headless render (`hyperframes browser install` downloads Chromium on
 * first use; that download did not complete in this sandbox).
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { FrameDescriptor } from './frames.js';
import { escapeHtml } from './captions.js';
import { getTemplate, type BrandTemplate } from './templates.js';

export interface CompositionOptions {
  width: number;
  height: number;
  fps?: number;
  compositionId?: string;
}

export interface RenderFramesOptions extends CompositionOptions {
  outPath: string;
  /** BrandTemplate or template id. Defaults to 'bold-social'. */
  template?: BrandTemplate | string;
  /** Working dir for the generated composition (render temp files are
   *  written here — keep it off small tmpfs mounts). Defaults to a
   *  sibling of outPath. */
  workDir?: string;
  /** Timeout for the render CLI in ms. Defaults to 10 minutes. */
  timeoutMs?: number;
}

/** One word recovered from caption HTML, with real timestamps. */
export interface ParsedCaptionWord {
  word: string;
  start: number;
  end: number;
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Recovers words + timings from HTML produced by renderCaptionHtml.
 * Round-trips buildCues → renderCaptionHtml → parseCaptionWords.
 */
export function parseCaptionWords(captionHtml: string): ParsedCaptionWord[] {
  const out: ParsedCaptionWord[] = [];
  const re = /<span class="w[^"]*" data-start="([\d.eE+-]+)" data-duration="([\d.eE+-]+)">(.*?)<\/span>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(captionHtml)) !== null) {
    const start = Number(m[1]);
    const duration = Number(m[2]);
    if (Number.isFinite(start) && Number.isFinite(duration) && duration > 0) {
      out.push({ word: unescapeHtml(m[3] ?? ''), start, end: start + duration });
    }
  }
  return out;
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url);
}

function captionCss(template: BrandTemplate, width: number): string {
  const scale = width / 1080;
  const fontSize = Math.round(template.caption.fontSizePx * scale);
  const strokePx = Math.max(0, Math.round(template.caption.strokePx * scale));
  const stroke = strokePx > 0
    ? `-webkit-text-stroke: ${strokePx}px #000; paint-order: stroke fill;`
    : '';
  const pos =
    template.caption.position === 'center'
      ? 'top: 50%; transform: translate(-50%, -50%);'
      : 'bottom: 14%; transform: translateX(-50%);';
  return `
.sf-caption {
  position: absolute; left: 50%; ${pos}
  width: 88%; text-align: center;
  font-family: ${template.fontStack};
  font-size: ${fontSize}px; font-weight: 900; line-height: 1.28;
  color: ${template.colors.fg};
  text-transform: uppercase;
  text-shadow: 0 2px 12px rgba(0,0,0,.55);
  ${stroke}
  pointer-events: none;
}
.sf-caption .w.active { color: ${template.colors.highlight}; }
.sf-caption .w.upcoming { opacity: .55; }
.sf-scene { position: absolute; inset: 0; overflow: hidden; background: ${template.colors.bg}; }
.sf-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.sf-hl { position: absolute; inset: 0; }`;
}

function backgroundHtml(frame: FrameDescriptor, start: number): string {
  if (frame.background.kind === 'broll') {
    const url = escapeHtml(frame.background.url);
    if (isVideoUrl(frame.background.url)) {
      return `<video class="clip sf-bg" data-start="${start}" data-duration="${frame.durationSec}" data-track-index="0" src="${url}" muted playsinline></video>`;
    }
    return `<img class="sf-bg" src="${url}" alt="" />`;
  }
  return '';
}

/**
 * Rebuilds caption HTML with exactly one word highlighted (by index).
 * The emitted spans carry NO timing attributes on purpose: the
 * Hyperframes runtime would interpret inner timing attributes as
 * composition-global time and wrongly hide words. Timing lives only on
 * the flat overlay `.clip` divs (see buildCompositionHtml).
 */
function captionWithActive(words: ParsedCaptionWord[], activeIndex: number): string {
  return words
    .map((w, i) => {
      const cls = i === activeIndex ? 'w active' : 'w';
      return `<span class="${cls}">${escapeHtml(w.word)}</span>`;
    })
    .join(' ');
}

/**
 * Builds a complete, self-contained Hyperframes composition HTML string
 * for the given frames. Pure and deterministic.
 */
export function buildCompositionHtml(
  frames: FrameDescriptor[],
  template: BrandTemplate,
  opts: CompositionOptions,
): string {
  const fps = opts.fps ?? 30;
  const compositionId = opts.compositionId ?? 'shorts-forge';
  const total = frames.reduce((s, f) => s + f.durationSec, 0);

  let offset = 0;
  const scenes: string[] = [];
  for (const frame of frames) {
    const start = offset;
    const words = parseCaptionWords(frame.captionHtmlAt(0));
    const baseCaption = captionWithActive(words, -1);
    const bgStyle =
      frame.background.kind === 'color'
        ? ` style="background: ${escapeHtml(frame.background.color)};"`
        : '';

    // Base scene clip: background + full caption, no highlight.
    scenes.push(
      `<div class="clip sf-scene" id="scene-${frame.segmentId}" data-start="${start}" data-duration="${frame.durationSec}" data-track-index="0"${bgStyle}>` +
        backgroundHtml(frame, start) +
        `<div class="sf-caption">${baseCaption}</div>` +
        `</div>`,
    );

    // One flat overlay clip per word: same caption box, that word highlighted.
    words.forEach((w, i) => {
      scenes.push(
        `<div class="clip sf-hl" id="hl-${frame.segmentId}-w${i}" data-start="${start + w.start}" data-duration="${w.end - w.start}" data-track-index="1">` +
          `<div class="sf-caption">${captionWithActive(words, i)}</div>` +
          `</div>`,
      );
    });

    offset += frame.durationSec;
  }

  return `<!DOCTYPE html>
<html lang="pt-PT">
<head>
<meta charset="utf-8" />
<style>${captionCss(template, opts.width)}</style>
</head>
<body style="margin:0">
<div data-composition-id="${escapeHtml(compositionId)}" data-start="0" data-duration="${total}" data-width="${opts.width}" data-height="${opts.height}" data-fps="${fps}" data-no-timeline style="position:relative;width:${opts.width}px;height:${opts.height}px">
${scenes.join('\n')}
</div>
</body>
</html>`;
}

/**
 * Resolves the hyperframes CLI entry point without relying on PATH/npx,
 * so renderFrames works from any working directory.
 */
function hyperframesBin(): string[] {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('hyperframes/package.json');
    return [process.execPath, join(dirname(pkgPath), 'bin', 'hyperframes.mjs')];
  } catch {
    return ['npx', 'hyperframes']; // fallback: hope PATH/npx resolves it
  }
}
/** Resolves a BrandTemplate from a template object or id. */
function resolveTemplate(t: BrandTemplate | string | undefined): BrandTemplate {
  if (!t) return getTemplate('bold-social');
  return typeof t === 'string' ? getTemplate(t) : t;
}

/**
 * Renders frames to a video file via the Hyperframes CLI.
 *
 * Steps: build composition HTML → write to workDir → spawn
 * `hyperframes render -c composition.html -o outPath` → verify output.
 *
 * Requires the hyperframes bundled browser on first use
 * (`npx hyperframes browser install`). Throws on CLI failure.
 */
export async function renderFrames(
  frames: FrameDescriptor[],
  opts: RenderFramesOptions,
): Promise<string> {
  if (frames.length === 0) throw new Error('renderFrames: sem frames para renderizar.');
  const template = resolveTemplate(opts.template);
  const outPath = resolve(opts.outPath);
  const workDir = resolve(
    opts.workDir ?? join(dirname(outPath), `.shorts-forge-hf-${Date.now()}`),
  );
  mkdirSync(workDir, { recursive: true });
  mkdirSync(dirname(outPath), { recursive: true });

  const compPath = join(workDir, 'composition.html');
  writeFileSync(compPath, buildCompositionHtml(frames, template, opts), 'utf8');

  // NOTE: hyperframes resolves -c relative to cwd, so pass the bare filename.
  const timeout = opts.timeoutMs ?? 10 * 60 * 1000;
  const hfBin = hyperframesBin();
  const res = spawnSync(
    hfBin[0]!,
    [...hfBin.slice(1), 'render', '-c', 'composition.html', '-o', outPath, '--quiet'],
    { timeout, encoding: 'utf8', cwd: workDir },
  );
  if (res.error) {
    throw new Error(`renderFrames: falha ao executar o CLI hyperframes: ${String(res.error)}`);
  }
  if (res.status !== 0 || !existsSync(outPath)) {
    const tail = String(res.stderr ?? '').slice(-2000);
    throw new Error(
      `renderFrames: o CLI hyperframes falhou (exit ${res.status}). ${tail}`,
    );
  }
  return outPath;
}

/**
 * Validates a generated composition with `hyperframes lint`.
 * Useful in Phase 3 pipelines before an expensive render.
 */
export function lintCompositionHtml(
  html: string,
  workDir?: string,
): { ok: boolean; output: string } {
  const dir = resolve(workDir ?? join(process.cwd(), `.shorts-forge-hf-lint-${Date.now()}`));
  mkdirSync(dir, { recursive: true });
  const compPath = join(dir, 'composition.html');
  writeFileSync(compPath, html, 'utf8');
  const hfBin = hyperframesBin();
  const res = spawnSync(hfBin[0]!, [...hfBin.slice(1), 'lint', compPath, '--json'], {
    timeout: 60_000,
    encoding: 'utf8',
    cwd: dir,
  });
  const output = String(res.stdout ?? '') + String(res.stderr ?? '');
  return { ok: res.status === 0, output };
}
