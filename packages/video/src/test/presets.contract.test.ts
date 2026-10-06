/**
 * Contract tests for platform presets — the preset TABLE
 * (packages/video/src/presets.ts) and its end-to-end honoring in the
 * render path (render.ts / ffmpeg.ts).
 *
 * These complement the API-level contract
 * (packages/pipeline/test/presets.contract.test.ts — POST /api/jobs):
 * here we verify that the table itself is correct, documented and
 * internally consistent, and that a preset actually drives the canvas,
 * the caption safe area and the final loudness target.
 *
 * Documented values live in docs/platforms.md ("valores sensatos, não
 * especificações oficiais"); the tests assert the code matches the doc.
 *
 * Run: npm test (tsc → node --test dist/test)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  listPresets,
  presetIds,
  getPreset,
  isPlatformPresetId,
  defaultPresetForFormat,
  resolvePreset,
  safeAreaPx,
} from '../presets.js';
import { canvasForPreset, renderTargetFor } from '../render.js';
import { buildAssembleArgs } from '../ffmpeg.js';

// ── Table correctness ────────────────────────────────────────────────

describe('preset table — correctness and internal consistency', () => {
  const EXPECTED: Record<string, { format: string; width: number; height: number }> = {
    tiktok: { format: '9:16', width: 1080, height: 1920 },
    'youtube-shorts': { format: '9:16', width: 1080, height: 1920 },
    'youtube-long': { format: '16:9', width: 1920, height: 1080 },
    'instagram-reels': { format: '9:16', width: 1080, height: 1920 },
  };

  it('has exactly the four documented presets, in a stable order', () => {
    assert.deepEqual(presetIds(), ['tiktok', 'youtube-shorts', 'youtube-long', 'instagram-reels']);
    assert.deepEqual(
      listPresets().map((p) => p.id),
      presetIds(),
    );
  });

  it('every preset implies a format consistent with its canvas', () => {
    for (const p of listPresets()) {
      const exp = EXPECTED[p.id];
      assert.ok(exp, `unexpected preset id ${p.id}`);
      assert.equal(p.format, exp!.format, `${p.id}: format`);
      assert.equal(p.width, exp!.width, `${p.id}: width`);
      assert.equal(p.height, exp!.height, `${p.id}: height`);
      const portraitCanvas = p.height > p.width;
      assert.equal(p.format === '9:16', portraitCanvas, `${p.id}: format matches canvas orientation`);
    }
  });

  it('max recommended duration: 180 s for short-form, null for long-form', () => {
    assert.equal(getPreset('tiktok').maxRecommendedDurationSec, 180);
    assert.equal(getPreset('youtube-shorts').maxRecommendedDurationSec, 180);
    assert.equal(getPreset('instagram-reels').maxRecommendedDurationSec, 180);
    assert.equal(getPreset('youtube-long').maxRecommendedDurationSec, null);
  });

  it('safe areas are sane fractions (no preset eats the whole canvas)', () => {
    for (const p of listPresets()) {
      for (const [k, v] of Object.entries(p.safeArea)) {
        assert.ok(v >= 0 && v < 0.5, `${p.id}.safeArea.${k} = ${v} (fraction 0–0.5)`);
      }
      assert.ok(p.safeArea.top + p.safeArea.bottom < 1, `${p.id}: vertical insets < 100%`);
      assert.ok(p.safeArea.left + p.safeArea.right < 1, `${p.id}: horizontal insets < 100%`);
    }
  });

  it('safe-area ordering follows the documented platform knowledge', () => {
    // TikTok's right rail is the widest of the vertical presets…
    const tt = getPreset('tiktok').safeArea;
    const yt = getPreset('youtube-shorts').safeArea;
    const ig = getPreset('instagram-reels').safeArea;
    assert.ok(tt.right >= yt.right, 'tiktok.right >= youtube-shorts.right');
    // …and Instagram's bottom caption/description zone is the tallest.
    assert.ok(ig.bottom >= tt.bottom, 'instagram-reels.bottom >= tiktok.bottom');
  });

  it('all presets target −14 LUFS (the documented platform normalization)', () => {
    for (const p of listPresets()) {
      assert.equal(p.loudnessLufs, -14, `${p.id}: loudnessLufs`);
    }
  });

  it('labels, descriptions and quirks are non-empty pt-PT strings', () => {
    for (const p of listPresets()) {
      assert.ok(p.label.length > 0, `${p.id}: label`);
      assert.ok(p.description.length > 0, `${p.id}: description`);
      assert.ok(p.quirks.length > 0, `${p.id}: quirks`);
      for (const q of p.quirks) assert.ok(q.length > 10, `${p.id}: quirk text`);
    }
  });

  it('getPreset throws a pt-PT error listing the valid ids', () => {
    assert.throws(() => getPreset('vimeo'), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Preset desconhecido/);
      assert.match(err.message, /tiktok/);
      return true;
    });
  });

  it('isPlatformPresetId is a sound type guard', () => {
    assert.equal(isPlatformPresetId('tiktok'), true);
    assert.equal(isPlatformPresetId('vimeo'), false);
    assert.equal(isPlatformPresetId(''), false);
    assert.equal(isPlatformPresetId(42), false);
    assert.equal(isPlatformPresetId(undefined), false);
  });
});

// ── Resolution / precedence ──────────────────────────────────────────

describe('preset resolution (docs/platforms.md precedence)', () => {
  it('defaultPresetForFormat maps 9:16 → youtube-shorts, 16:9 → youtube-long', () => {
    assert.equal(defaultPresetForFormat('9:16').id, 'youtube-shorts');
    assert.equal(defaultPresetForFormat('16:9').id, 'youtube-long');
  });

  it('resolvePreset: explicit preset wins over a conflicting format', () => {
    const p = resolvePreset('tiktok', '16:9');
    assert.equal(p.id, 'tiktok');
    assert.equal(p.format, '9:16');
  });

  it('resolvePreset: bare format maps to the aspect default', () => {
    assert.equal(resolvePreset(undefined, '16:9').id, 'youtube-long');
    assert.equal(resolvePreset(null, '9:16').id, 'youtube-shorts');
  });

  it('resolvePreset: neither → youtube-shorts (the tool default)', () => {
    assert.equal(resolvePreset().id, 'youtube-shorts');
  });

  it('resolvePreset: unknown preset id throws (pt-PT)', () => {
    assert.throws(() => resolvePreset('vimeo'), /Preset desconhecido/);
  });
});

describe('safeAreaPx — fractions become concrete pixels', () => {
  it('tiktok 1080×1920 → documented insets in px', () => {
    const px = safeAreaPx(getPreset('tiktok'), 1080, 1920);
    assert.deepEqual(px, {
      top: Math.round(0.1 * 1920),
      right: Math.round(0.15 * 1080),
      bottom: Math.round(0.16 * 1920),
      left: Math.round(0.06 * 1080),
    });
    assert.deepEqual(px, { top: 192, right: 162, bottom: 307, left: 65 });
  });

  it('scales with the canvas (same fractions, smaller preview)', () => {
    const full = safeAreaPx(getPreset('instagram-reels'), 1080, 1920);
    const small = safeAreaPx(getPreset('instagram-reels'), 360, 640);
    assert.equal(small.top, Math.round(full.top / 3));
    assert.equal(small.bottom, Math.round(full.bottom / 3));
  });
});

// ── End-to-end honoring in the render path ───────────────────────────

describe('render honoring: preset drives canvas, safe area and loudness', () => {
  it('canvasForPreset returns the preset canvas', () => {
    assert.deepEqual(canvasForPreset('tiktok'), { width: 1080, height: 1920 });
    assert.deepEqual(canvasForPreset('youtube-long'), { width: 1920, height: 1080 });
  });

  it('renderTargetFor: preset wins and carries its safe area', () => {
    const t = renderTargetFor({ preset: 'tiktok', format: '16:9' });
    assert.deepEqual({ width: t.width, height: t.height }, { width: 1080, height: 1920 });
    assert.equal(t.format, '9:16');
    assert.deepEqual(t.safeArea, getPreset('tiktok').safeArea);
  });

  it('renderTargetFor: no preset → aspect canvas, no safe area (legacy path)', () => {
    const t = renderTargetFor({ format: '16:9' });
    assert.deepEqual({ width: t.width, height: t.height }, { width: 1920, height: 1080 });
    assert.equal(t.format, '16:9');
    assert.equal(t.safeArea, undefined);
  });

  it('buildAssembleArgs applies the preset loudness target (−14), default stays −16', () => {
    const base = {
      segmentClips: ['/tmp/a.mp4'],
      narrationTracks: ['/tmp/n.wav'],
      outPath: '/tmp/out.mp4',
      format: '9:16' as const,
      hwAccel: 'none' as const,
    };
    const withPreset = buildAssembleArgs({ ...base, loudnessLufs: -14 });
    const filter = withPreset[withPreset.indexOf('-filter_complex') + 1]!;
    assert.match(filter, /loudnorm=I=-14:TP=-1\.5:LRA=11/);

    const legacy = buildAssembleArgs(base);
    const legacyFilter = legacy[legacy.indexOf('-filter_complex') + 1]!;
    assert.match(legacyFilter, /loudnorm=I=-16:TP=-1\.5:LRA=11/);
  });
});
