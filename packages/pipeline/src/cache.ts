/**
 * Cache de transcrições em disco.
 *
 * A transcrição (faster-whisper, Fase 2) é cara; o resultado é guardado em
 * disco indexado pelo sha256 dos BYTES do ficheiro de áudio — o mesmo
 * áudio nunca é transcrito duas vezes. Ficheiros de cache corruptos são
 * tratados como "miss" e substituídos na próxima escrita.
 *
 * Localização por omissão: <repo>/outputs/.cache/transcripts
 * (a raiz do repo é localizada a partir deste módulo).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TranscriptionResult } from '@shorts-forge/shared';

interface CacheEnvelope {
  sha256: string;
  result: TranscriptionResult;
}

/** sha256 hex of a file's raw bytes. Throws a descriptive error if unreadable. */
export function sha256File(path: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error(`não foi possível ler o ficheiro de áudio: ${path}`);
  }
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Default cache dir: <repo>/outputs/.cache/transcripts. The repo root is
 * found by walking up from this module until a package.json named
 * "shorts-forge" is found.
 */
export function defaultCacheDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown };
      if (pkg.name === 'shorts-forge') {
        return join(dir, 'outputs', '.cache', 'transcripts');
      }
    } catch {
      // Not a readable package.json here — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'não foi possível localizar a raiz do repositório shorts-forge (package.json "shorts-forge")',
  );
}

function cacheFileFor(cacheDir: string, sha256: string): string {
  return join(cacheDir, `${sha256}.json`);
}

function isValidResult(v: unknown): v is TranscriptionResult {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['text'] === 'string' &&
    Array.isArray(r['words']) &&
    typeof r['language'] === 'string'
  );
}

/**
 * Returns the cached transcription for this audio file, or null on a miss
 * (no entry, corrupt entry, or hash mismatch).
 */
export function getCachedTranscript(
  audioPath: string,
  cacheDir?: string,
): TranscriptionResult | null {
  const dir = cacheDir ?? defaultCacheDir();
  const key = sha256File(audioPath);
  const file = cacheFileFor(dir, key);
  try {
    const envelope = JSON.parse(readFileSync(file, 'utf8')) as Partial<CacheEnvelope>;
    if (envelope.sha256 !== key) return null;
    if (!isValidResult(envelope.result)) return null;
    return envelope.result;
  } catch {
    // Missing file, unreadable file, or invalid JSON → cache miss.
    return null;
  }
}

/**
 * Stores a transcription result for this audio file (creates directories as
 * needed; overwrites any previous/corrupt entry).
 */
export function putCachedTranscript(
  audioPath: string,
  result: TranscriptionResult,
  cacheDir?: string,
): void {
  const dir = cacheDir ?? defaultCacheDir();
  const key = sha256File(audioPath);
  mkdirSync(dir, { recursive: true });
  const envelope: CacheEnvelope = { sha256: key, result };
  writeFileSync(cacheFileFor(dir, key), JSON.stringify(envelope), 'utf8');
}
