/**
 * Per-job output directories.
 *
 * Layout (relative to the outputs root):
 *   outputs/<jobId>/final.mp4        — final assembled video
 *   outputs/<jobId>/preview.mp4      — fast low-res preview (+ .spechash sidecar)
 *   outputs/<jobId>/segments/*.mp4   — per-segment Hyperframes clips
 *
 * The root defaults to `<cwd>/outputs` and can be overridden with
 * `SHORTS_FORGE_OUTPUTS_DIR` (useful for tests and custom setups).
 */
import { resolve, join } from 'node:path';

export function outputsRoot(): string {
  const fromEnv = (process.env.SHORTS_FORGE_OUTPUTS_DIR ?? '').trim();
  return resolve(fromEnv !== '' ? fromEnv : join(process.cwd(), 'outputs'));
}

/** Sanitized per-job directory: `outputs/<jobId>/`. */
export function jobOutputsDir(jobId: string): string {
  const safe = jobId.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 80) || 'job';
  return join(outputsRoot(), safe);
}
