/**
 * Tests for outputs.ts — per-job output directory resolution.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { jobOutputsDir, outputsRoot } from '../src/outputs.js';

test('outputsRoot: SHORTS_FORGE_OUTPUTS_DIR override', () => {
  const prev = process.env.SHORTS_FORGE_OUTPUTS_DIR;
  process.env.SHORTS_FORGE_OUTPUTS_DIR = '/tmp/sf-outputs-test';
  try {
    assert.equal(outputsRoot(), '/tmp/sf-outputs-test');
  } finally {
    if (prev === undefined) delete process.env.SHORTS_FORGE_OUTPUTS_DIR;
    else process.env.SHORTS_FORGE_OUTPUTS_DIR = prev;
  }
});

test('outputsRoot: default is <cwd>/outputs, absolute', () => {
  const prev = process.env.SHORTS_FORGE_OUTPUTS_DIR;
  delete process.env.SHORTS_FORGE_OUTPUTS_DIR;
  try {
    assert.equal(outputsRoot(), join(process.cwd(), 'outputs'));
    assert.ok(isAbsolute(outputsRoot()));
  } finally {
    if (prev !== undefined) process.env.SHORTS_FORGE_OUTPUTS_DIR = prev;
  }
});

test('jobOutputsDir: outputs/<jobId>, sanitized', () => {
  const dir = jobOutputsDir('job-123-abc');
  assert.equal(basename(dir), 'job-123-abc');
  assert.equal(dirname(dir), outputsRoot());

  const evil = jobOutputsDir('../../etc/passwd');
  assert.ok(!evil.includes('..'), 'sem path traversal');
  assert.ok(isAbsolute(evil));
  assert.ok(evil.startsWith(outputsRoot() + sep));
});
