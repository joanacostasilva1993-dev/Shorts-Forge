import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHwAccel, buildAssembleArgs, assemble } from '../index.js';
import type { AssembleOptions } from '../index.js';

function baseOpts(overrides: Partial<AssembleOptions> = {}): AssembleOptions {
  return {
    segmentClips: ['/tmp/seg-01.mp4', '/tmp/seg-02.mp4'],
    narrationTracks: ['/tmp/narr-01.wav', '/tmp/narr-02.wav'],
    outPath: '/tmp/final.mp4',
    format: '9:16',
    hwAccel: 'none',
    ...overrides,
  };
}

test('detectHwAccel runs without throwing and returns a valid value', () => {
  const accel = detectHwAccel();
  assert.ok(['nvenc', 'videotoolbox', 'qsv', 'none'].includes(accel));
});

test('sidechaincompress present only when music is given', () => {
  const withMusic = buildAssembleArgs({ ...baseOpts(), musicPath: '/tmp/musica.mp3' });
  const fc = withMusic[withMusic.indexOf('-filter_complex') + 1]!;
  assert.ok(fc.includes('sidechaincompress'), 'music → ducking filter present');
  assert.ok(fc.includes('amix'), 'ducked music mixed with narration');

  const withoutMusic = buildAssembleArgs(baseOpts());
  const fc2 = withoutMusic[withoutMusic.indexOf('-filter_complex') + 1]!;
  assert.ok(!fc2.includes('sidechaincompress'), 'no music → no ducking');
});

test('loudnorm present on the master audio', () => {
  const args = buildAssembleArgs({ ...baseOpts(), musicPath: '/tmp/m.mp3' });
  const fc = args[args.indexOf('-filter_complex') + 1]!;
  assert.ok(fc.includes('loudnorm=I=-16:TP=-1.5:LRA=11'));
});

test('encoder follows hwAccel', () => {
  const expected: Record<string, string> = {
    nvenc: 'h264_nvenc',
    videotoolbox: 'h264_videotoolbox',
    qsv: 'h264_qsv',
    none: 'libx264',
  };
  for (const [accel, enc] of Object.entries(expected)) {
    const args = buildAssembleArgs(baseOpts({ hwAccel: accel as AssembleOptions['hwAccel'] }));
    assert.equal(args[args.indexOf('-c:v') + 1], enc, `hwAccel=${accel}`);
  }
});

test('canvas: 1080x1920 for 9:16, 1920x1080 for 16:9', () => {
  const vertical = buildAssembleArgs(baseOpts({ format: '9:16' }));
  const fcV = vertical[vertical.indexOf('-filter_complex') + 1]!;
  assert.ok(fcV.includes('scale=1080:1920'), 'vertical canvas');

  const horizontal = buildAssembleArgs(baseOpts({ format: '16:9' }));
  const fcH = horizontal[horizontal.indexOf('-filter_complex') + 1]!;
  assert.ok(fcH.includes('scale=1920:1080'), 'horizontal canvas');
});

test('segments are concatenated in order; yuv420p + aac', () => {
  const args = buildAssembleArgs(baseOpts());
  const fc = args[args.indexOf('-filter_complex') + 1]!;
  assert.ok(fc.includes('[v0][v1]concat=n=2:v=1:a=0[vcat]'));
  assert.ok(args.includes('yuv420p'));
  assert.ok(args.includes('aac'));
  assert.equal(args[args.length - 1], '/tmp/final.mp4');
  // inputs: 2 clips + 2 narrations, in order
  assert.deepEqual(
    args.filter((a, i) => args[i - 1] === '-i'),
    ['/tmp/seg-01.mp4', '/tmp/seg-02.mp4', '/tmp/narr-01.wav', '/tmp/narr-02.wav'],
  );
});

test('single narration track does not use concat for audio', () => {
  const args = buildAssembleArgs(baseOpts({ narrationTracks: ['/tmp/n.wav'] }));
  const fc = args[args.indexOf('-filter_complex') + 1]!;
  assert.ok(!fc.includes('concat=n=1'));
});

test('requires at least one segment clip', () => {
  assert.throws(() => buildAssembleArgs(baseOpts({ segmentClips: [] })), /pelo menos um clip/);
});

test('assemble is an unmistakable stub', async () => {
  await assert.rejects(() => assemble(baseOpts()), /STUB/);
});
