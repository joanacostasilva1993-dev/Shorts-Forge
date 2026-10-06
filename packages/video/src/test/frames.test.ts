import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Spec } from '@shorts-forge/shared';
import { buildFrames } from '../index.js';
import { getTemplate } from '../index.js';

function sampleSpec(): Spec {
  return {
    version: 1,
    title: 'Teste',
    format: '9:16',
    language: 'pt-PT',
    segments: [
      {
        id: 'seg-01',
        narration: 'Olá mundo',
        visualKeywords: ['teste'],
        brollDescription: 'fundo de teste',
        targetDurationSec: 4.0,
        actualDurationSec: 3.5,
        tts: {
          audioPath: '/tmp/a1.mp3',
          words: [
            { word: 'Olá', start: 0.1, end: 0.5 },
            { word: 'mundo', start: 0.5, end: 1.0 },
          ],
          durationSec: 3.5,
        },
        broll: { provider: 'image', clipId: 'c1', url: 'https://exemplo.pt/fundo.jpg', durationSec: 10 },
      },
      {
        id: 'seg-02',
        narration: 'Sem TTS ainda',
        visualKeywords: [],
        brollDescription: '',
        targetDurationSec: 2.0,
      },
    ],
  };
}

test('buildFrames: one descriptor per segment, real durations first', () => {
  const { frames, totalDurationSec, template } = buildFrames(sampleSpec(), 'minimal');
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.segmentId, 'seg-01');
  assert.equal(frames[0]!.durationSec, 3.5); // actualDurationSec wins
  assert.equal(frames[1]!.durationSec, 2.0); // falls back to targetDurationSec
  assert.equal(totalDurationSec, 5.5);
  assert.equal(template.id, 'minimal');
});

test('buildFrames: broll url vs template color fallback', () => {
  const { frames } = buildFrames(sampleSpec(), 'minimal');
  assert.deepEqual(frames[0]!.background, {
    kind: 'broll',
    url: 'https://exemplo.pt/fundo.jpg',
  });
  assert.deepEqual(frames[1]!.background, {
    kind: 'color',
    color: getTemplate('minimal').colors.bg,
  });
});

test('buildFrames: captionHtmlAt uses real word timestamps', () => {
  const { frames } = buildFrames(sampleSpec(), 'minimal');
  const atStart = frames[0]!.captionHtmlAt(0.2);
  assert.match(atStart, /<span class="w active"[^>]*>Olá<\/span>/);
  const atEnd = frames[0]!.captionHtmlAt(2.0);
  assert.ok(!atEnd.includes('active'));
  // segment without TTS → empty caption
  assert.equal(frames[1]!.captionHtmlAt(0), '');
});

test('buildFrames throws on unknown template', () => {
  assert.throws(() => buildFrames(sampleSpec(), 'inexistente'), /Modelo desconhecido/);
});
