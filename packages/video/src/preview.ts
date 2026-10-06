/**
 * Static HTML preview of a Spec.
 *
 * Writes a self-contained HTML file with one card per segment: segment id,
 * narration, timing (start → end within the video) and the caption HTML
 * rendered statically with the template's styling. This is a REVIEW
 * artifact (for the UI's "preview" step), not a video render.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Spec } from '@shorts-forge/shared';
import { buildFrames } from './frames.js';
import { getTemplate } from './templates.js';
import { escapeHtml } from './captions.js';

function previewCss(templateId: string): string {
  const t = getTemplate(templateId);
  return `
body { font-family: ${t.fontStack}; background: #141419; color: #eee; margin: 0; padding: 32px; }
h1 { font-size: 22px; margin: 0 0 6px; }
.sub { color: #999; margin-bottom: 24px; font-size: 14px; }
.card { background: #1e1e26; border: 1px solid #333; border-radius: 12px; padding: 20px; margin-bottom: 16px; max-width: 720px; }
.card .seg-id { font-size: 12px; color: ${t.colors.accent}; letter-spacing: 2px; text-transform: uppercase; }
.card .timing { font-size: 13px; color: #aaa; margin: 6px 0 10px; font-variant-numeric: tabular-nums; }
.card .narration { font-size: 16px; line-height: 1.5; margin-bottom: 14px; }
.caption-box { background: ${t.colors.bg}; border-radius: 8px; padding: 18px; text-align: center;
  font-size: ${t.caption.fontSizePx * 0.55}px; font-weight: 900; line-height: 1.35; text-transform: uppercase; }
.caption-box .w.active { color: ${t.colors.highlight}; }
.caption-box .w.upcoming { opacity: .55; }`;
}

/**
 * Writes the preview HTML file and returns its absolute path.
 */
export function writePreviewHtml(spec: Spec, templateId: string, outPath: string): string {
  const { frames, totalDurationSec } = buildFrames(spec, templateId);
  const abs = resolve(outPath);
  mkdirSync(dirname(abs), { recursive: true });

  let offset = 0;
  const cards = frames.map((frame, i) => {
    const segment = spec.segments[i]!;
    const start = offset;
    const end = offset + frame.durationSec;
    offset = end;
    return `<section class="card">
  <div class="seg-id">${escapeHtml(frame.segmentId)}</div>
  <div class="timing">${start.toFixed(2)}s → ${end.toFixed(2)}s · duração ${frame.durationSec.toFixed(2)}s</div>
  <div class="narration">${escapeHtml(segment.narration)}</div>
  <div class="caption-box">${frame.captionHtmlAt(0)}</div>
</section>`;
  });

  const html = `<!DOCTYPE html>
<html lang="pt-PT">
<head>
<meta charset="utf-8" />
<title>Pré-visualização — ${escapeHtml(spec.title)}</title>
<style>${previewCss(templateId)}</style>
</head>
<body>
<h1>${escapeHtml(spec.title)}</h1>
<div class="sub">${frames.length} segmentos · ${totalDurationSec.toFixed(2)}s no total · formato ${escapeHtml(spec.format)} · modelo ${escapeHtml(templateId)}</div>
${cards.join('\n')}
</body>
</html>`;

  writeFileSync(abs, html, 'utf8');
  return abs;
}
