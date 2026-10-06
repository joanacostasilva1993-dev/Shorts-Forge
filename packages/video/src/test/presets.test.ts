/**
 * Tests for platform presets (presets.ts): the catalog (resolution/aspect
 * per preset), preset resolution/precedence, safe-area px conversion, the
 * safe-area application to caption positioning (captions.ts), and the
 * render path — the composition HTML carries the preset's canvas and the
 * safe-area-clamped caption CSS.
 *
 * Run: npm test (tsc → node --test dist/test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Segment, VideoFormat } from '@shorts-forge/shared';
import {
  listPresets,
  presetIds,
  getPreset,
  isPlatformPresetId,
  resolvePreset,
  defaultPresetForFormat,
  safeAreaPx,
  captionBoxFor,
  hookTopFrac,
  canvasForPreset,
  renderTargetFor,
  buildSegmentComposition,
} from '../index.js';

function segment(): Segment {
  return {
    id: 'seg-01',
    narration: 'Olá mundo',
    visualKeywords: [],
    brollDescription: '',
    targetDurationSec: 4.0,
    tts: {
      audioPath: '/tmp/narracao.mp3',
      words: [
        { word: 'Olá', start: 0.5, end: 1.0 },
        { word: 'mundo', start: 1.0, end: 1.8 },
      ],
      durationSec: 3.0,
    },
    actualDurationSec: 3.25,
  };
}

test('catalog: four presets with the expected resolution and aspect', () => {
  const expected: Record<string, { w: number; h: number; f: VideoFormat }> = {
    tiktok: { w: 1080, h: 1920, f: '9:16' },
    'youtube-shorts': { w: 1080, h: 1920, f: '9:16' },
    'youtube-long': { w: 1920, h: 1080, f: '16:9' },
    'instagram-reels': { w: 1080, h: 1920, f: '9:16' },
  };
  assert.deepEqual(presetIds().sort(), Object.keys(expected).sort());
  for (const p of listPresets()) {
    const e = expected[p.id]!;
    assert.equal(p.width, e.w, `${p.id} width`);
    assert.equal(p.height, e.h, `${p.id} height`);
    assert.equal(p.format, e.f, `${p.id} format`);
    assert.ok(p.label.length > 0, `${p.id} label`);
    assert.ok(p.description.length > 0, `${p.id} description`);
    assert.equal(p.loudnessLufs, -14, `${p.id} loudness`);
    assert.ok(p.quirks.length > 0, `${p.id} quirks`);
    for (const k of ['top', 'right', 'bottom', 'left'] as const) {
      const v = p.safeArea[k];
      assert.ok(v >= 0 && v < 0.5, `${p.id} safeArea.${k} in [0, 0.5)`);
    }
    assert.ok(
      p.maxRecommendedDurationSec === null || p.maxRecommendedDurationSec > 0,
      `${p.id} max duration`,
    );
  }
});

test('catalog: max recommended durations', () => {
  assert.equal(getPreset('tiktok').maxRecommendedDurationSec, 180);
  assert.equal(getPreset('youtube-shorts').maxRecommendedDurationSec, 180);
  assert.equal(getPreset('instagram-reels').maxRecommendedDurationSec, 180);
  assert.equal(getPreset('youtube-long').maxRecommendedDurationSec, null);
});

test('getPreset: unknown id throws listing the valid ids', () => {
  assert.throws(() => getPreset('vimeo'), /Preset desconhecido.*tiktok.*youtube-shorts/);
});

test('isPlatformPresetId: type guard', () => {
  assert.equal(isPlatformPresetId('tiktok'), true);
  assert.equal(isPlatformPresetId('youtube-long'), true);
  assert.equal(isPlatformPresetId('vimeo'), false);
  assert.equal(isPlatformPresetId(undefined), false);
  assert.equal(isPlatformPresetId(42), false);
});

test('resolvePreset: explicit preset wins over a conflicting format', () => {
  const p = resolvePreset('tiktok', '16:9');
  assert.equal(p.id, 'tiktok');
  assert.equal(p.format, '9:16');
});

test('resolvePreset: format alone maps to the aspect default preset', () => {
  assert.equal(resolvePreset(undefined, '16:9').id, 'youtube-long');
  assert.equal(resolvePreset(undefined, '9:16').id, 'youtube-shorts');
  assert.equal(resolvePreset().id, 'youtube-shorts');
});

test('resolvePreset: unknown preset id throws', () => {
  assert.throws(() => resolvePreset('vimeo'), /Preset desconhecido/);
});

test('defaultPresetForFormat', () => {
  assert.equal(defaultPresetForFormat('9:16').id, 'youtube-shorts');
  assert.equal(defaultPresetForFormat('16:9').id, 'youtube-long');
});

test('safeAreaPx: fractions convert to px on the canvas', () => {
  const tiktok = getPreset('tiktok');
  assert.deepEqual(safeAreaPx(tiktok, 1080, 1920), {
    top: 192,
    right: 162,
    bottom: 307,
    left: 65,
  });
  const long = getPreset('youtube-long');
  assert.deepEqual(safeAreaPx(long, 1920, 1080), {
    top: 86,
    right: 77,
    bottom: 130,
    left: 77,
  });
});

test('captionBoxFor: lower-third bottom is max(template default, safe bottom)', () => {
  const tiktok = getPreset('tiktok').safeArea;
  const box = captionBoxFor('lower-third', tiktok);
  assert.equal(box.bottomFrac, 0.16); // TikTok's 16% pushes captions up
  const long = getPreset('youtube-long').safeArea;
  assert.equal(captionBoxFor('lower-third', long).bottomFrac, 0.14); // template default wins
});

test('captionBoxFor: center keeps vertical center but narrows the width', () => {
  const tiktok = getPreset('tiktok').safeArea;
  const box = captionBoxFor('center', tiktok);
  assert.equal(box.bottomFrac, 0.14); // untouched
  assert.ok(Math.abs(box.maxWidthFrac - (1 - 0.15 - 0.06)) < 1e-9);
  assert.ok(box.maxWidthFrac < 0.88);
});

test('hookTopFrac: hook line respects the top safe margin', () => {
  assert.equal(hookTopFrac(getPreset('tiktok').safeArea), 0.1);
  assert.equal(hookTopFrac(getPreset('youtube-long').safeArea), 0.08);
  assert.equal(hookTopFrac(getPreset('youtube-shorts').safeArea), 0.08);
});

test('canvasForPreset / renderTargetFor: resolution per preset', () => {
  assert.deepEqual(canvasForPreset('youtube-long'), { width: 1920, height: 1080 });
  assert.deepEqual(canvasForPreset('instagram-reels'), { width: 1080, height: 1920 });
  const t = renderTargetFor({ preset: 'tiktok' });
  assert.deepEqual(
    { width: t.width, height: t.height, format: t.format },
    { width: 1080, height: 1920, format: '9:16' },
  );
  assert.deepEqual(t.safeArea, getPreset('tiktok').safeArea);
  const f = renderTargetFor({ format: '16:9' });
  assert.deepEqual(
    { width: f.width, height: f.height, format: f.format, safeArea: f.safeArea },
    { width: 1920, height: 1080, format: '16:9', safeArea: undefined },
  );
});

test('render path: composition HTML carries the preset canvas resolution', () => {
  const preset = getPreset('youtube-long');
  const canvas = canvasForPreset('youtube-long');
  const html = buildSegmentComposition(segment(), 'bold-social', {
    width: canvas.width,
    height: canvas.height,
    fps: 30,
    safeArea: preset.safeArea,
  });
  assert.ok(html.includes('data-width="1920"'), 'data-width=1920');
  assert.ok(html.includes('data-height="1080"'), 'data-height=1080');
  assert.ok(html.includes('width:1920px'), 'composition style width');
  assert.ok(html.includes('height:1080px'), 'composition style height');
});

test('render path: caption CSS honors the preset safe area', () => {
  // 'minimal' uses lower-third captions → TikTok's 16% bottom margin wins.
  const html = buildSegmentComposition(segment(), 'minimal', {
    width: 1080,
    height: 1920,
    fps: 30,
    safeArea: getPreset('tiktok').safeArea,
  });
  assert.ok(html.includes('bottom: 16.0%;'), 'lower-third caption at 16% from bottom');
  // 'bold-social' uses center captions → width shrinks under the side rails.
  const center = buildSegmentComposition(segment(), 'bold-social', {
    width: 1080,
    height: 1920,
    fps: 30,
    safeArea: getPreset('tiktok').safeArea,
  });
  assert.ok(center.includes('width: 79.0%;'), 'center caption narrowed to 79%');
  // Without a safe area the legacy defaults are untouched.
  const legacy = buildSegmentComposition(segment(), 'minimal', {
    width: 1080,
    height: 1920,
    fps: 30,
  });
  assert.ok(legacy.includes('bottom: 14.0%;'), 'legacy lower-third bottom stays 14%');
  assert.ok(legacy.includes('width: 88.0%;'), 'legacy caption width stays 88%');
});
