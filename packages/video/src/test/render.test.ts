/**
 * Unit tests for the per-segment rendering pipeline (render.ts):
 * buildSegmentFrame → buildSegmentComposition → lint gate →
 * renderSegmentClip, plus the real assemble()/assembleJob() pre-flight.
 *
 * Rendering itself (hyperframes browser / FFmpeg muxing) is covered by
 * render.e2e.test.ts. These tests stay fast and hermetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Segment } from '@shorts-forge/shared';
import {
  buildFrameDescriptor,
  buildSegmentFrame,
  buildSegmentComposition,
  buildCompositionHtml,
  getTemplate,
  lintCompositionHtml,
  resolveBrollAssetUrl,
  renderSegmentClip,
  assemble,
  assembleJob,
  HOOK_SHOW_SEC,
} from '../index.js';

/** Overrides may explicitly set fields to undefined (= absent). */
function segment(
  overrides: { [K in keyof Segment]?: Segment[K] | undefined } = {},
): Segment {
  const base: Segment = {
    id: 'seg-01',
    narration: 'Olá mundo',
    visualKeywords: [],
    brollDescription: '',
    targetDurationSec: 4.0,
    hookLine: 'Isto muda tudo',
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
  const out = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete (out as Record<string, unknown>)[k];
    else (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

test('buildFrameDescriptor: per-segment primitive, real durations first', () => {
  const frame = buildFrameDescriptor(segment(), getTemplate('bold-social'));
  assert.equal(frame.segmentId, 'seg-01');
  assert.equal(frame.durationSec, 3.25); // actualDurationSec wins
  assert.equal(frame.hookLine, 'Isto muda tudo');
  // karaoke timing from the real TTS words
  assert.match(frame.captionHtmlAt(0.6), /<span class="w active"[^>]*>Olá<\/span>/);
});

test('buildFrameDescriptor: falls back to targetDurationSec; blank hookLine dropped', () => {
  const frame = buildFrameDescriptor(
    segment({ actualDurationSec: undefined, hookLine: '   ' }),
    getTemplate('minimal'),
  );
  assert.equal(frame.durationSec, 4.0);
  assert.equal(frame.hookLine, undefined);
});

test('buildSegmentFrame: resolves localPath broll to a file:// URL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-broll-'));
  const local = join(dir, 'clip.mp4');
  writeFileSync(local, 'fake-bytes');
  const frame = buildSegmentFrame(
    segment({
      broll: {
        provider: 'pexels',
        clipId: 'pexels-1',
        url: 'https://cdn.example/1.mp4',
        localPath: local,
        durationSec: 8,
      },
    }),
    'bold-social',
  );
  assert.deepEqual(frame.background, { kind: 'broll', url: `file://${local}` });
});

test('resolveBrollAssetUrl: https passthrough; local url; null when unusable', () => {
  assert.equal(
    resolveBrollAssetUrl({ provider: 'pixabay', clipId: 'x', url: 'https://cdn.example/v.mp4', durationSec: 5 }),
    'https://cdn.example/v.mp4',
  );
  const dir = mkdtempSync(join(tmpdir(), 'sf-broll-'));
  const local = join(dir, 'still.png');
  writeFileSync(local, 'fake-bytes');
  assert.equal(
    resolveBrollAssetUrl({ provider: 'image', clipId: 'kb', url: local, durationSec: 5 }),
    `file://${local}`,
  );
  // localPath wins over the remote url
  const clip = join(dir, 'cached.mp4');
  writeFileSync(clip, 'fake-bytes');
  assert.equal(
    resolveBrollAssetUrl({ provider: 'pexels', clipId: 'p', url: 'https://cdn.example/p.mp4', localPath: clip, durationSec: 5 }),
    `file://${clip}`,
  );
  // missing localPath + empty url → null (caller keeps the colour fallback)
  assert.equal(
    resolveBrollAssetUrl({ provider: 'template', clipId: 't', url: '', durationSec: 5 }),
    null,
  );
  assert.equal(
    resolveBrollAssetUrl({ provider: 'image', clipId: 'kb2', url: '/caminho/que/nao/existe.png', durationSec: 5 }),
    null,
  );
});

test('buildSegmentComposition: hook overlay + karaoke + template styling', () => {
  const html = buildSegmentComposition(segment(), 'bold-social', { width: 1080, height: 1920 });
  // hook overlay: track 2, from 0, accent colour, escaped text
  assert.ok(html.includes('id="hook-seg-01"'), 'hook overlay present');
  assert.ok(html.includes('data-track-index="2"'), 'hook on track 2');
  assert.ok(html.includes(`data-start="0" data-duration="${HOOK_SHOW_SEC}"`), 'hook timing');
  assert.ok(html.includes('#ff2e88'), 'accent colour of bold-social');
  assert.ok(html.includes('Isto muda tudo'), 'hook text');
  // karaoke overlays: one per word, real timings
  const overlays = html.match(/class="clip sf-hl"/g) ?? [];
  assert.equal(overlays.length, 2);
  assert.ok(html.includes('data-start="0.5" data-duration="0.5"'));
  // single scene for the single segment
  const scenes = html.match(/class="clip sf-scene"/g) ?? [];
  assert.equal(scenes.length, 1);
});

test('buildSegmentComposition: no hook overlay when hookLine is absent', () => {
  const html = buildSegmentComposition(segment({ hookLine: undefined }), 'minimal', {
    width: 1080,
    height: 1920,
  });
  assert.ok(!html.includes('sf-hookline'), 'no hook markup');
  assert.ok(!html.includes('id="hook-seg-01"'));
});

test('buildSegmentComposition: hookLine is HTML-escaped', () => {
  const html = buildSegmentComposition(segment({ hookLine: '<script>alert(1)</script>' }), 'bold-social', {
    width: 1080,
    height: 1920,
  });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script not present');
  assert.ok(html.includes('&lt;script&gt;'), 'escaped');
});

test('buildCompositionHtml: hook duration clamped to short shots', () => {
  const frame = buildFrameDescriptor(segment({ actualDurationSec: 1.0 }), getTemplate('bold-social'));
  const html = buildCompositionHtml([frame], getTemplate('bold-social'), { width: 1080, height: 1920 });
  assert.ok(html.includes('data-start="0" data-duration="1"'), 'clamped to the 1s shot');
});

test('lintCompositionHtml: real lint passes on a generated composition', () => {
  const html = buildSegmentComposition(segment(), 'bold-social', { width: 1080, height: 1920 });
  const dir = mkdtempSync(join(tmpdir(), 'sf-lint-'));
  const { ok, output } = lintCompositionHtml(html, dir);
  assert.equal(ok, true, `lint devia passar. Output: ${output.slice(0, 800)}`);
});

test('renderSegmentClip: failing lint gate aborts before any render', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-clip-'));
  const outPath = join(dir, 'seg-01.mp4');
  let gateRan = false;
  await assert.rejects(
    () =>
      renderSegmentClip(segment(), {
        outDir: dir,
        outPath,
        // Injected gate: fails on purpose — renderFrames must never run.
        lint: () => {
          gateRan = true;
          return { ok: false, output: 'achado de teste: overlay em falta' };
        },
      }),
    /chumbou no lint do Hyperframes/,
  );
  assert.equal(gateRan, true, 'o gate correu');
  assert.equal(
    (await import('node:fs')).existsSync(outPath),
    false,
    'nenhum clip foi renderizado após o chumbo no lint',
  );
});

test('assemble: pre-flight fails honestly on missing music track', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-assemble-'));
  const clip = join(dir, 'seg-01.mp4');
  const narr = join(dir, 'narr-01.wav');
  writeFileSync(clip, 'fake-bytes');
  writeFileSync(narr, 'fake-bytes');
  await assert.rejects(
    () =>
      assemble({
        segmentClips: [clip],
        narrationTracks: [narr],
        musicPath: join(dir, 'musica-que-nao-existe.mp3'),
        outPath: join(dir, 'final.mp4'),
        format: '9:16',
        hwAccel: 'none',
      }),
    /faixa de música em falta/,
  );
});

test('assembleJob: honest failures — count mismatch and missing TTS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-assemble-'));
  await assert.rejects(
    () =>
      assembleJob({
        segments: [segment(), segment({ id: 'seg-02' })],
        segmentClips: ['/tmp/a.mp4'],
        outDir: dir,
        format: '9:16',
      }),
    /têm de coincidir por ordem/,
  );
  await assert.rejects(
    () =>
      assembleJob({
        segments: [segment({ tts: undefined })],
        segmentClips: ['/tmp/a.mp4'],
        outDir: dir,
        format: '9:16',
      }),
    /não tem áudio TTS válido/,
  );
});
