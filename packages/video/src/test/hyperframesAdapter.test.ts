import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompositionHtml,
  parseCaptionWords,
  getTemplate,
  buildFrames,
} from '../index.js';
import type { Spec } from '@shorts-forge/shared';

function sampleSpec(): Spec {
  return {
    version: 1,
    title: 'Composição',
    format: '9:16',
    language: 'pt-PT',
    segments: [
      {
        id: 'seg-01',
        narration: 'Olá mundo',
        visualKeywords: [],
        brollDescription: '',
        targetDurationSec: 4.0,
        tts: {
          audioPath: '/tmp/a.mp3',
          words: [
            { word: 'Olá', start: 0.5, end: 1.0 },
            { word: 'mundo', start: 1.0, end: 1.8 },
          ],
          durationSec: 4.0,
        },
        broll: { provider: 'image', clipId: 'x', url: 'https://exemplo.pt/bg.jpg', durationSec: 9 },
      },
      {
        id: 'seg-02',
        narration: 'Fim',
        visualKeywords: [],
        brollDescription: '',
        targetDurationSec: 2.0,
      },
    ],
  };
}

test('parseCaptionWords round-trips renderCaptionHtml', () => {
  const { frames } = buildFrames(sampleSpec(), 'bold-social');
  const parsed = parseCaptionWords(frames[0]!.captionHtmlAt(0));
  assert.deepEqual(parsed, [
    { word: 'Olá', start: 0.5, end: 1.0 },
    { word: 'mundo', start: 1.0, end: 1.8 },
  ]);
  assert.deepEqual(parseCaptionWords(frames[1]!.captionHtmlAt(0)), []);
});

test('buildCompositionHtml declares the composition root correctly', () => {
  const { frames } = buildFrames(sampleSpec(), 'bold-social');
  const html = buildCompositionHtml(frames, getTemplate('bold-social'), {
    width: 1080,
    height: 1920,
  });
  assert.ok(html.includes('data-composition-id="shorts-forge"'));
  assert.ok(html.includes('data-width="1080"'));
  assert.ok(html.includes('data-height="1920"'));
  assert.ok(html.includes('data-duration="6"')); // 4 + 2
  assert.ok(html.includes('data-fps="30"'));
  assert.ok(html.includes('#ffe14d')); // highlight color of bold-social
});

test('buildCompositionHtml: one scene clip per frame + one overlay per word', () => {
  const { frames } = buildFrames(sampleSpec(), 'bold-social');
  const html = buildCompositionHtml(frames, getTemplate('minimal'), {
    width: 1080,
    height: 1920,
  });
  const scenes = html.match(/class="clip sf-scene"/g) ?? [];
  assert.equal(scenes.length, 2);
  const overlays = html.match(/class="clip sf-hl"/g) ?? [];
  assert.equal(overlays.length, 2); // two words in seg-01, none in seg-02
  // word overlay timing is absolute on the composition timeline
  assert.ok(html.includes('data-start="0.5" data-duration="0.5"'));
  assert.ok(html.includes('data-start="1" data-duration="0.8"'));
  // scene timing: seg-01 at 0, seg-02 at 4
  assert.ok(html.includes('id="scene-seg-01" data-start="0" data-duration="4"'));
  assert.ok(html.includes('id="scene-seg-02" data-start="4" data-duration="2"'));
  // b-roll image present; color fallback for seg-02
  assert.ok(html.includes('src="https://exemplo.pt/bg.jpg"'));
});

test('buildCompositionHtml is deterministic', () => {
  const { frames } = buildFrames(sampleSpec(), 'cinematic');
  const t = getTemplate('cinematic');
  const opts = { width: 1920, height: 1080 };
  assert.equal(buildCompositionHtml(frames, t, opts), buildCompositionHtml(frames, t, opts));
});
