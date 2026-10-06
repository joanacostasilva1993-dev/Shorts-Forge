/**
 * Tests for retime.ts — the Phase B re-timing heart of the architecture.
 * Run: npm test (tsc → node --test dist/test)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { retimeSpec, totalDurationSec, DEFAULT_BREATH_MARGIN_SEC } from '../src/retime.js';
import type { Spec, TtsResult } from '@shorts-forge/shared';

function makeSpec(): Spec {
  return {
    version: 1,
    title: 'Teste',
    format: '9:16',
    language: 'pt-PT',
    segments: [
      {
        id: 'seg-01',
        narration: 'Olá mundo, isto é um teste.',
        visualKeywords: ['hello', 'world'],
        brollDescription: 'Plano de teste',
        targetDurationSec: 5.0,
      },
      {
        id: 'seg-02',
        narration: 'Segundo segmento do teste.',
        visualKeywords: ['second', 'test'],
        brollDescription: 'Outro plano de teste',
        targetDurationSec: 4.0,
      },
    ],
  };
}

function makeTts(lastEnd: number, wordCount = 3): TtsResult {
  const words = Array.from({ length: wordCount }, (_, i) => ({
    word: `w${i}`,
    start: (lastEnd / wordCount) * i,
    end: (lastEnd / wordCount) * (i + 1),
  }));
  return { audioPath: '/tmp/seg.wav', words, durationSec: lastEnd + 0.1, voice: 'pt-test' };
}

describe('retimeSpec', () => {
  it('sets actualDurationSec = last word end + default breath margin (0.25)', () => {
    const spec = makeSpec();
    const tts = makeTts(3.2);
    const out = retimeSpec(spec, new Map([['seg-01', tts]]));

    const seg = out.segments[0];
    assert.ok(seg);
    assert.equal(seg?.actualDurationSec, 3.2 + DEFAULT_BREATH_MARGIN_SEC);
    assert.equal(DEFAULT_BREATH_MARGIN_SEC, 0.25);
  });

  it('attaches the tts result (without the voice field, per canonical type)', () => {
    const spec = makeSpec();
    const tts = makeTts(2.0);
    const out = retimeSpec(spec, new Map([['seg-01', tts]]));

    const seg = out.segments[0];
    assert.deepEqual(seg?.tts, {
      audioPath: '/tmp/seg.wav',
      words: tts.words,
      durationSec: 2.1,
    });
  });

  it('respects a custom breathMarginSec', () => {
    const spec = makeSpec();
    const out = retimeSpec(spec, new Map([['seg-01', makeTts(4.0)]]), { breathMarginSec: 0.5 });
    assert.equal(out.segments[0]?.actualDurationSec, 4.5);
  });

  it('rejects a negative breathMarginSec', () => {
    assert.throws(
      () => retimeSpec(makeSpec(), new Map(), { breathMarginSec: -1 }),
      /breathMarginSec/,
    );
  });

  it('multi-segment: only timed segments get actualDurationSec', () => {
    const spec = makeSpec();
    const out = retimeSpec(spec, new Map([['seg-02', makeTts(3.0)]]));

    assert.equal(out.segments[0]?.actualDurationSec, undefined);
    assert.equal(out.segments[0]?.targetDurationSec, 5.0); // untouched plan
    assert.equal(out.segments[1]?.actualDurationSec, 3.25);
  });

  it('segment with a TTS result but empty words: no invented timing', () => {
    const spec = makeSpec();
    const empty: TtsResult = { audioPath: '/tmp/empty.wav', words: [], durationSec: 0.4, voice: 'pt-test' };
    const out = retimeSpec(spec, new Map([['seg-01', empty]]));

    const seg = out.segments[0];
    assert.ok(seg?.tts, 'tts audio should still be attached');
    assert.equal(seg?.actualDurationSec, undefined, 'no words → no measured timing');
    assert.equal(seg?.targetDurationSec, 5.0);
  });

  it('does not mutate the input spec (returns a NEW object)', () => {
    const spec = makeSpec();
    const before = JSON.stringify(spec);
    const out = retimeSpec(spec, new Map([['seg-01', makeTts(3.0)]]));

    assert.notEqual(out, spec);
    assert.notEqual(out.segments[0], spec.segments[0]);
    assert.equal(JSON.stringify(spec), before, 'input spec must be unchanged');
    assert.equal(spec.segments[0]?.actualDurationSec, undefined);
  });

  it('rounds actualDurationSec to millisecond precision', () => {
    const spec = makeSpec();
    const out = retimeSpec(spec, new Map([['seg-01', makeTts(1.23456)]]));
    assert.equal(out.segments[0]?.actualDurationSec, 1.485);
  });
});

describe('totalDurationSec', () => {
  it('sums actual durations when present, targets otherwise', () => {
    const spec = makeSpec();
    const out = retimeSpec(spec, new Map([['seg-01', makeTts(3.0)]]));
    // seg-01 → 3.25 actual, seg-02 → 4.0 target
    assert.equal(totalDurationSec(out), 7.25);
  });
});
