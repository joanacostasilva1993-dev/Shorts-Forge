import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Spec } from '@shorts-forge/shared';
import { writePreviewHtml, buildFrames, getTemplate } from '../index.js';

function sampleSpec(): Spec {
  return {
    version: 1,
    title: 'Pré-visualização <teste>',
    format: '9:16',
    language: 'pt-PT',
    segments: [
      {
        id: 'seg-01',
        narration: 'Primeira frase',
        visualKeywords: [],
        brollDescription: '',
        targetDurationSec: 3.0,
        tts: {
          audioPath: '/tmp/a.mp3',
          words: [{ word: 'Primeira', start: 0, end: 0.5 }],
          durationSec: 3.0,
        },
      },
      {
        id: 'seg-02',
        narration: 'Segunda frase',
        visualKeywords: [],
        brollDescription: '',
        targetDurationSec: 2.0,
      },
    ],
  };
}

test('writePreviewHtml writes a valid file containing segment ids', () => {
  const outPath = join(tmpdir(), `shorts-forge-preview-${Date.now()}`, 'preview.html');
  const returned = writePreviewHtml(sampleSpec(), 'cinematic', outPath);
  assert.equal(returned, outPath);
  assert.ok(existsSync(outPath), 'file exists');
  const html = readFileSync(outPath, 'utf8');
  assert.ok(html.includes('seg-01'));
  assert.ok(html.includes('seg-02'));
  assert.ok(html.includes('Primeira frase'));
  assert.ok(html.includes('0.00s → 3.00s'));
  assert.ok(html.includes('3.00s → 5.00s'));
  assert.ok(html.includes('<!DOCTYPE html>'));
  // title is escaped
  assert.ok(html.includes('Pré-visualização &lt;teste&gt;'));
  rmSync(outPath);
});

test('writePreviewHtml works for all templates', () => {
  for (const id of ['bold-social', 'minimal', 'cinematic']) {
    const outPath = join(tmpdir(), `shorts-forge-preview-${id}-${Date.now()}.html`);
    writePreviewHtml(sampleSpec(), id, outPath);
    assert.ok(existsSync(outPath));
    const html = readFileSync(outPath, 'utf8');
    assert.ok(html.includes(getTemplate(id).colors.highlight));
    rmSync(outPath);
  }
});

test('buildFrames is the source of preview timing', () => {
  const { frames, totalDurationSec } = buildFrames(sampleSpec(), 'minimal');
  assert.equal(totalDurationSec, 5.0);
  assert.equal(frames[0]!.captionHtmlAt(0.1).includes('active'), true);
});
