/**
 * Tests for cache.ts — transcript cache keyed by sha256 of audio bytes.
 * Run: npm test (tsc → node --test dist/test)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getCachedTranscript,
  putCachedTranscript,
  sha256File,
} from '../src/cache.js';
import type { TranscriptionResult } from '@shorts-forge/shared';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pipeline-cache-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeAudio(name: string, bytes: string): string {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

function makeResult(): TranscriptionResult {
  return {
    text: 'Olá, isto é uma transcrição de teste.',
    words: [
      { word: 'Olá,', start: 0.0, end: 0.4 },
      { word: 'isto', start: 0.5, end: 0.8 },
    ],
    language: 'pt-PT',
  };
}

describe('transcript cache', () => {
  it('round-trips a transcription result', () => {
    const audio = makeAudio('a.wav', 'fake-audio-bytes-1');
    const result = makeResult();

    assert.equal(getCachedTranscript(audio, dir), null, 'miss before put');
    putCachedTranscript(audio, result, dir);
    assert.deepEqual(getCachedTranscript(audio, dir), result);
  });

  it('creates nested cache directories as needed', () => {
    const audio = makeAudio('a.wav', 'bytes');
    const nested = join(dir, 'deep', 'nested', 'dir');
    putCachedTranscript(audio, makeResult(), nested);
    assert.deepEqual(getCachedTranscript(audio, nested), makeResult());
  });

  it('hash is stable: identical bytes → same cache entry (different filenames)', () => {
    const a1 = makeAudio('one.wav', 'same-bytes');
    const a2 = makeAudio('two.wav', 'same-bytes');
    assert.equal(sha256File(a1), sha256File(a2));

    putCachedTranscript(a1, makeResult(), dir);
    assert.deepEqual(getCachedTranscript(a2, dir), makeResult(), 'second file hits the same entry');
  });

  it('different bytes → different cache entries', () => {
    const a1 = makeAudio('one.wav', 'bytes-A');
    const a2 = makeAudio('two.wav', 'bytes-B');

    putCachedTranscript(a1, makeResult(), dir);
    assert.equal(getCachedTranscript(a2, dir), null);
  });

  it('corrupt cache file is treated as a miss and overwritten', () => {
    const audio = makeAudio('a.wav', 'audio-bytes');
    const key = createHash('sha256').update('audio-bytes').digest('hex');
    const cacheFile = join(dir, `${key}.json`);
    writeFileSync(cacheFile, '{ this is not valid json !!!');

    assert.equal(getCachedTranscript(audio, dir), null, 'corrupt file → miss');

    const result = makeResult();
    putCachedTranscript(audio, result, dir); // overwrites the corrupt file
    assert.deepEqual(getCachedTranscript(audio, dir), result);

    // The file is now valid JSON again.
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf8')) as { sha256: string };
    assert.equal(parsed.sha256, key);
  });

  it('cache file with wrong hash is treated as a miss', () => {
    const audio = makeAudio('a.wav', 'audio-bytes');
    const key = createHash('sha256').update('audio-bytes').digest('hex');
    writeFileSync(
      join(dir, `${key}.json`),
      JSON.stringify({ sha256: 'deadbeef', result: makeResult() }),
    );
    assert.equal(getCachedTranscript(audio, dir), null);
  });

  it('cache file with invalid result shape is treated as a miss', () => {
    const audio = makeAudio('a.wav', 'audio-bytes');
    const key = createHash('sha256').update('audio-bytes').digest('hex');
    writeFileSync(
      join(dir, `${key}.json`),
      JSON.stringify({ sha256: key, result: { nope: true } }),
    );
    assert.equal(getCachedTranscript(audio, dir), null);
  });

  it('missing audio file throws a descriptive error', () => {
    assert.throws(
      () => getCachedTranscript(join(dir, 'nope.wav'), dir),
      /não foi possível ler o ficheiro de áudio/,
    );
  });
});
