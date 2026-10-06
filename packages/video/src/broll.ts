/**
 * B-roll resolution for shorts-forge (Phase B, step 3 of the pipeline).
 *
 * For every Segment, resolves one visual clip following the fallback
 * cascade from ARCHITECTURE.md §7:
 *
 *   1. Pexels video search (free tier, needs PEXELS_API_KEY)
 *   2. Pixabay video search (free tier, needs PIXABAY_API_KEY)
 *   3. Ken Burns clip: slow zoom/pan over a locally generated gradient
 *      still, encoded with FFmpeg — no keys, no network
 *   4. Template gradient background (last resort; works even without FFmpeg
 *      because buildFrames() falls back to the template colour)
 *
 * Rules honoured here:
 *  - free-only by default: the pipeline works with NO keys at all;
 *  - no clip is reused within the same project (UsedClipRegistry,
 *    persisted as JSON under the project dir);
 *  - downloads are cached at <cacheDir>/<clipId>.mp4 and never repeated;
 *  - API errors / timeouts / rate limits fall through the cascade silently
 *    (logged, never thrown) — every segment ALWAYS ends with a valid
 *    `broll` entry, never without visuals;
 *  - clip durations are recorded honestly: the renderer trims longer
 *    clips and loops/freezes shorter ones (a montage decision, not made
 *    here).
 *
 * Everything that needs the network or FFmpeg is injectable or guarded so
 * the pure parts (scoring, selection, registry) are fully unit-testable.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { BrollProvider, Segment, VideoFormat } from '@shorts-forge/shared';

// ── Public shapes ────────────────────────────────────────────────────

export type { BrollProvider };

/** One stock-video candidate returned by Pexels/Pixabay. */
export interface BrollCandidate {
  provider: 'pexels' | 'pixabay';
  /** Namespaced id, e.g. "pexels-3121459" — used for cache + no-repeat. */
  clipId: string;
  /** Direct video-file URL (the rendition we would download). */
  url: string;
  /** Source page URL (for attribution). */
  pageUrl: string;
  durationSec: number;
  width: number;
  height: number;
  /** Lower-cased search tags / matched query tokens. */
  tags: string[];
  attribution: string;
}

/** Breakdown of the scoring heuristic (see scoreCandidate). */
export interface CandidateScore {
  total: number;
  relevance: number;
  durationFit: number;
  orientation: number;
}

export interface ResolveBrollOptions {
  /** Output aspect; drives the orientation request + scoring. */
  format: VideoFormat;
  /** Where downloaded clips live. Default: <cwd>/outputs/cache/broll */
  cacheDir?: string;
  /** Job/project dir holding broll-registry.json. Default: process.cwd() */
  projectDir?: string;
  env?: Record<string, string | undefined>;
  /** Injectable fetch (tests mock the HTTP layer through this). */
  fetchImpl?: typeof fetch;
  /** Progress / degradation notes. Default: silent. */
  log?: ((message: string) => void) | undefined;
  requestTimeoutMs?: number;
  /** FFmpeg binary. Default: "ffmpeg" from PATH. */
  ffmpegPath?: string;
}

export type ResolvedBroll = NonNullable<Segment['broll']>;

// ── Scoring ──────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  'a,an,the,and,or,but,of,to,in,on,at,for,with,from,by,as,is,are,was,were,be,been,being,it,its,this,that,these,those,i,you,he,she,we,they,them,his,her,their,our,your,my,me,him,us,not,no,do,does,did,will,would,can,could,should,very,just,so,such,into,over,after,before,between,through,during,about,above,below,up,down,out,off,again,once,here,there,when,where,why,how,all,any,both,each,few,more,most,other,some,only,own,same,than,too'.split(
    ',',
  ),
);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Fraction of `needles` found (exact or substring) inside `haystack`. */
function overlap(needles: string[], haystack: string[]): number {
  if (needles.length === 0) return 0.5; // neutral: nothing to match against
  let hits = 0;
  for (const n of needles) {
    if (haystack.some((h) => h === n || h.includes(n) || n.includes(h))) hits += 1;
  }
  return hits / needles.length;
}

/**
 * Scores one candidate for a segment.
 *
 * Heuristic (documented so it can be tuned, not magic):
 *  - relevance (55%): 60% keyword↔tag overlap + 40% brollDescription↔tag
 *    overlap. Tags are the provider's own tags (Pixabay) or the matched
 *    query tokens (Pexels, which returns no tags — the search engine
 *    already did the semantic matching).
 *  - durationFit (35%): clips >= neededSec score 1.0 for an exact match,
 *    decaying to 0.7 at 2× the needed length (longer is trimmed, so excess
 *    is cheap but wasteful); shorter clips score proportionally up to
 *    0.75 (they must loop, which is visibly worse than trimming).
 *  - orientation (10%): 1.0 when the clip's orientation matches the
 *    output format, 0.0/0.25 otherwise.
 */
export function scoreCandidate(
  candidate: BrollCandidate,
  segment: Pick<Segment, 'visualKeywords' | 'brollDescription'>,
  neededSec: number,
  format: VideoFormat,
): CandidateScore {
  const tagTokens = candidate.tags.flatMap(tokenize);
  const kwTokens = segment.visualKeywords.flatMap(tokenize);
  const descTokens = tokenize(segment.brollDescription);
  const relevance = 0.6 * overlap(kwTokens, tagTokens) + 0.4 * overlap(descTokens, tagTokens);

  const needed = Math.max(neededSec, 0.5);
  const dur = Math.max(candidate.durationSec, 0);
  let durationFit: number;
  if (dur >= needed) {
    durationFit = 1 - 0.3 * Math.min(1, (dur - needed) / needed);
  } else {
    durationFit = 0.75 * (dur / needed);
  }

  const portrait = format === '9:16';
  const isPortrait = candidate.height > candidate.width;
  const orientation = portrait ? (isPortrait ? 1 : 0) : isPortrait ? 0.25 : 1;

  const total = 0.55 * relevance + 0.35 * durationFit + 0.1 * orientation;
  return { total, relevance, durationFit, orientation };
}

/**
 * Picks the best unused candidate. Returns null when every candidate was
 * already used in this project (caller falls through the cascade).
 */
export function selectBestCandidate(
  candidates: BrollCandidate[],
  usedClipIds: ReadonlySet<string>,
  segment: Pick<Segment, 'visualKeywords' | 'brollDescription'>,
  neededSec: number,
  format: VideoFormat,
): BrollCandidate | null {
  const scored = candidates
    .filter((c) => !usedClipIds.has(c.clipId) && c.url !== '')
    .map((c) => ({ c, s: scoreCandidate(c, segment, neededSec, format).total }))
    .sort((a, b) => b.s - a.s);
  return scored.length > 0 && scored[0] ? scored[0].c : null;
}

// ── Pexels / Pixabay search ──────────────────────────────────────────

const PEXELS_SEARCH_URL = 'https://api.pexels.com/videos/search';
const PIXABAY_SEARCH_URL = 'https://pixabay.com/api/videos/';

interface PexelsVideoFile {
  id?: number;
  quality?: string;
  file_type?: string;
  width?: number;
  height?: number;
  link?: string;
}
interface PexelsVideo {
  id?: number;
  width?: number;
  height?: number;
  duration?: number;
  url?: string;
  video_files?: PexelsVideoFile[];
}
interface PixabayVideoHit {
  id?: number;
  pageURL?: string;
  duration?: number;
  tags?: string;
  user?: string;
  videos?: Record<string, { url?: string; width?: number; height?: number } | undefined>;
}

function targetWidth(format: VideoFormat): number {
  return format === '9:16' ? 1080 : 1920;
}

/** Builds the search query: English keywords first, description as back-up. */
export function buildSearchQuery(segment: Pick<Segment, 'visualKeywords' | 'brollDescription'>): string {
  const kws = segment.visualKeywords.map((k) => k.trim()).filter(Boolean).slice(0, 3);
  if (kws.length > 0) return kws.join(' ');
  return tokenize(segment.brollDescription).slice(0, 6).join(' ') || 'abstract background';
}

/** Picks the smallest mp4 rendition >= target width, else the largest. */
function pickPexelsFile(files: PexelsVideoFile[], wantWidth: number): PexelsVideoFile | null {
  const mp4 = files.filter((f) => f.file_type === 'video/mp4' && f.link && (f.width ?? 0) > 0);
  if (mp4.length === 0) return null;
  const bigEnough = mp4
    .filter((f) => (f.width ?? 0) >= wantWidth)
    .sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  if (bigEnough.length > 0 && bigEnough[0]) return bigEnough[0];
  return mp4.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0] ?? null;
}

function pickPixabayRendition(
  videos: PixabayVideoHit['videos'],
  wantWidth: number,
): { url: string; width: number; height: number } | null {
  if (!videos) return null;
  const entries = Object.values(videos).filter(
    (v): v is { url: string; width: number; height: number } =>
      !!v && typeof v.url === 'string' && (v.width ?? 0) > 0,
  );
  if (entries.length === 0) return null;
  const bigEnough = entries
    .filter((v) => v.width >= wantWidth)
    .sort((a, b) => a.width - b.width);
  const best = bigEnough[0] ?? entries.sort((a, b) => b.width - a.width)[0];
  return best ? { url: best.url, width: best.width, height: best.height } : null;
}

interface SearchDeps {
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

/**
 * REAL: Pexels video search (free tier). Throws on HTTP/network errors so
 * the cascade can fall through; never returns partial data silently.
 */
export async function searchPexels(
  segment: Pick<Segment, 'visualKeywords' | 'brollDescription'>,
  apiKey: string,
  format: VideoFormat,
  deps: SearchDeps,
): Promise<BrollCandidate[]> {
  const params = new URLSearchParams({
    query: buildSearchQuery(segment),
    orientation: format === '9:16' ? 'portrait' : 'landscape',
    size: 'medium',
    per_page: '15',
  });
  const res = await deps.fetchImpl(`${PEXELS_SEARCH_URL}?${params.toString()}`, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(deps.timeoutMs),
  });
  if (!res.ok) throw new Error(`Pexels search failed: HTTP ${res.status}`);
  const body = (await res.json()) as { videos?: PexelsVideo[] };
  const wantWidth = targetWidth(format);
  const out: BrollCandidate[] = [];
  for (const v of body.videos ?? []) {
    if (v.id == null) continue;
    const file = pickPexelsFile(v.video_files ?? [], wantWidth);
    if (!file?.link) continue;
    out.push({
      provider: 'pexels',
      clipId: `pexels-${v.id}`,
      url: file.link,
      pageUrl: v.url ?? '',
      durationSec: v.duration ?? 0,
      width: file.width ?? v.width ?? 0,
      height: file.height ?? v.height ?? 0,
      // Pexels returns no tags; the matched query tokens are the signal.
      tags: tokenize(buildSearchQuery(segment)),
      attribution: 'Video from Pexels',
    });
  }
  return out;
}

/**
 * REAL: Pixabay video search (free tier). Throws on HTTP/network errors so
 * the cascade can fall through; never returns partial data silently.
 */
export async function searchPixabay(
  segment: Pick<Segment, 'visualKeywords' | 'brollDescription'>,
  apiKey: string,
  format: VideoFormat,
  deps: SearchDeps,
): Promise<BrollCandidate[]> {
  const params = new URLSearchParams({
    key: apiKey,
    q: buildSearchQuery(segment),
    per_page: '15',
    safesearch: 'true',
    order: 'popular',
  });
  const res = await deps.fetchImpl(`${PIXABAY_SEARCH_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(deps.timeoutMs),
  });
  if (!res.ok) throw new Error(`Pixabay search failed: HTTP ${res.status}`);
  const body = (await res.json()) as { hits?: PixabayVideoHit[] };
  const wantWidth = targetWidth(format);
  const out: BrollCandidate[] = [];
  for (const h of body.hits ?? []) {
    if (h.id == null) continue;
    const rendition = pickPixabayRendition(h.videos, wantWidth);
    if (!rendition) continue;
    out.push({
      provider: 'pixabay',
      clipId: `pixabay-${h.id}`,
      url: rendition.url,
      pageUrl: h.pageURL ?? '',
      durationSec: h.duration ?? 0,
      width: rendition.width,
      height: rendition.height,
      tags: (h.tags ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
      attribution: h.user ? `Video by ${h.user} from Pixabay` : 'Video from Pixabay',
    });
  }
  return out;
}

// ── No-repeat registry ───────────────────────────────────────────────

const REGISTRY_FILENAME = 'broll-registry.json';

/**
 * Per-project record of used clip ids. Persisted as JSON under the
 * project dir so a re-run never reuses a clip within the same project.
 */
export class UsedClipRegistry {
  private used = new Set<string>();

  private constructor(private readonly projectDir: string) {}

  static async load(projectDir: string): Promise<UsedClipRegistry> {
    const reg = new UsedClipRegistry(projectDir);
    try {
      const raw = await readFile(path.join(projectDir, REGISTRY_FILENAME), 'utf8');
      const parsed = JSON.parse(raw) as { usedClipIds?: unknown };
      if (Array.isArray(parsed.usedClipIds)) {
        for (const id of parsed.usedClipIds) {
          if (typeof id === 'string') reg.used.add(id);
        }
      }
    } catch {
      // Missing/corrupt registry → start empty (never crash the render).
    }
    return reg;
  }

  has(clipId: string): boolean {
    return this.used.has(clipId);
  }

  get ids(): ReadonlySet<string> {
    return this.used;
  }

  /** Marks a clip as used and persists immediately. */
  async mark(clipId: string): Promise<void> {
    this.used.add(clipId);
    await this.save();
  }

  private async save(): Promise<void> {
    const file = path.join(this.projectDir, REGISTRY_FILENAME);
    const tmp = `${file}.tmp`;
    await mkdir(this.projectDir, { recursive: true });
    await writeFile(tmp, JSON.stringify({ version: 1, usedClipIds: [...this.used] }, null, 2), 'utf8');
    await rename(tmp, file);
  }
}

// ── Local cache ──────────────────────────────────────────────────────

export function defaultCacheDir(): string {
  return path.join(process.cwd(), 'outputs', 'cache', 'broll');
}

/** Deterministic cache file for a clip id: <cacheDir>/<clipId>.mp4 */
export function cachePathFor(cacheDir: string, clipId: string): string {
  const safe = clipId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 120) || 'clip';
  return path.join(cacheDir, `${safe}.mp4`);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * Downloads a URL into the cache (atomic: temp file + rename).
 * Returns true on success, false on ANY failure (network, HTTP error,
 * empty file) — the cascade falls through, never crashes.
 * Never re-downloads: an existing non-empty cache file is a hit.
 */
export async function downloadToCache(
  url: string,
  destPath: string,
  deps: SearchDeps & { log?: ((m: string) => void) | undefined },
): Promise<boolean> {
  try {
    if (await fileExists(destPath)) return true; // cache hit
    await mkdir(path.dirname(destPath), { recursive: true });
    const res = await deps.fetchImpl(url, { signal: AbortSignal.timeout(deps.timeoutMs) });
    if (!res.ok || !res.body) {
      deps.log?.(`B-roll download failed: HTTP ${res.status} for ${url}`);
      return false;
    }
    const tmp = `${destPath}.part`;
    await streamPipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(tmp));
    if (!(await fileExists(tmp))) {
      deps.log?.(`B-roll download produced an empty file for ${url}`);
      return false;
    }
    await rename(tmp, destPath);
    return true;
  } catch (err) {
    deps.log?.(`B-roll download error for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ── Local generation: Ken Burns + template gradient ──────────────────

const GRADIENT_PALETTES: Array<[string, string]> = [
  ['0d1b2a', '1b4f72'], // deep blue night
  ['2b1a0e', '7a4a1e'], // warm amber
  ['0e2a1a', '1e6b4a'], // forest green
  ['1a0e2a', '5a2a6b'], // dusk purple
  ['101418', '3a4a5a'], // slate grey
];

export type KenBurnsMotion = 'zoom-in' | 'zoom-out';

export function ffmpegAvailable(ffmpegPath = 'ffmpeg'): boolean {
  try {
    const res = spawnSync(ffmpegPath, ['-hide_banner', '-version'], { timeout: 10_000, encoding: 'utf8' });
    return res.status === 0;
  } catch {
    return false;
  }
}

/** Deterministic palette index + motion from the segment id. */
export function kenBurnsVariant(segmentId: string): { paletteIndex: number; motion: KenBurnsMotion } {
  const digest = createHash('sha256').update(segmentId).digest();
  const paletteIndex = digest[0]! % GRADIENT_PALETTES.length;
  const motion: KenBurnsMotion = digest[1]! % 2 === 0 ? 'zoom-in' : 'zoom-out';
  return { paletteIndex, motion };
}

export function clipIdForKenBurns(paletteIndex: number, motion: KenBurnsMotion, format: VideoFormat): string {
  return `kb-p${paletteIndex}-${motion}-${format === '9:16' ? '916' : '169'}`;
}

function canvasSize(format: VideoFormat): { w: number; h: number } {
  return format === '9:16' ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 };
}

/**
 * Builds the FFmpeg args that render one gradient still (PNG).
 * Pure — unit-testable without running FFmpeg.
 */
export function buildGradientStillArgs(opts: {
  outPng: string;
  width: number;
  height: number;
  c0: string;
  c1: string;
  ffmpegPath?: string;
}): string[] {
  const ff = opts.ffmpegPath ?? 'ffmpeg';
  return [
    ff,
    '-y',
    '-f', 'lavfi',
    '-i', `gradients=size=${opts.width}x${opts.height}:c0=0x${opts.c0}:c1=0x${opts.c1}:speed=0`,
    '-frames:v', '1',
    opts.outPng,
  ];
}

/**
 * Builds the FFmpeg args for a Ken Burns clip (slow zoom over a still).
 * Pure — unit-testable without running FFmpeg.
 */
export function buildKenBurnsArgs(opts: {
  imagePath: string;
  outMp4: string;
  durationSec: number;
  width: number;
  height: number;
  motion: KenBurnsMotion;
  fps?: number;
  ffmpegPath?: string;
}): string[] {
  const ff = opts.ffmpegPath ?? 'ffmpeg';
  const fps = opts.fps ?? 30;
  const frames = Math.max(1, Math.ceil(opts.durationSec * fps));
  // zoompan renders `frames` output frames from the single input still.
  const zoom =
    opts.motion === 'zoom-in'
      ? `min(zoom+0.0012,1.28)`
      : `max(1.28-0.0012*on,1.0)`;
  const vf =
    `scale=${opts.width * 2}:${opts.height * 2},` +
    `zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${opts.width}x${opts.height}:fps=${fps},` +
    `format=yuv420p`;
  return [
    ff, '-y',
    '-i', opts.imagePath,
    '-vf', vf,
    '-frames:v', String(frames),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-movflags', '+faststart',
    opts.outMp4,
  ];
}

/**
 * Builds the FFmpeg args for a static gradient clip (template fallback).
 * Pure — unit-testable without running FFmpeg.
 */
export function buildTemplateClipArgs(opts: {
  outMp4: string;
  durationSec: number;
  width: number;
  height: number;
  c0: string;
  c1: string;
  fps?: number;
  ffmpegPath?: string;
}): string[] {
  const ff = opts.ffmpegPath ?? 'ffmpeg';
  const fps = opts.fps ?? 30;
  const frames = Math.max(1, Math.ceil(opts.durationSec * fps));
  return [
    ff, '-y',
    '-f', 'lavfi',
    '-i', `gradients=size=${opts.width}x${opts.height}:c0=0x${opts.c0}:c1=0x${opts.c1}:speed=0`,
    '-vf', `scale=${opts.width}:${opts.height},format=yuv420p,fps=${fps}`,
    '-frames:v', String(frames),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-movflags', '+faststart',
    opts.outMp4,
  ];
}

function runFfmpeg(args: string[], ffmpegPath: string, log?: ((m: string) => void) | undefined): boolean {
  try {
    const [bin, ...rest] = args;
    const res = spawnSync(bin ?? ffmpegPath, rest, { timeout: 120_000, encoding: 'utf8' });
    if (res.status !== 0) {
      log?.(`FFmpeg failed (exit ${res.status}): ${String(res.stderr ?? '').slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (err) {
    log?.(`FFmpeg spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

interface LocalGenDeps {
  ffmpegPath: string;
  log?: ((m: string) => void) | undefined;
  /** Cap so a pathological duration can't encode forever. */
  maxDurationSec?: number;
}

/**
 * REAL: generates (or reuses from cache) a Ken Burns MP4 for the segment.
 * Returns the local path, or null when FFmpeg is missing/fails — the
 * cascade then falls through to the template gradient.
 */
export async function ensureKenBurnsClip(
  clipId: string,
  durationSec: number,
  format: VideoFormat,
  cacheDir: string,
  deps: LocalGenDeps & { paletteIndex: number; motion: KenBurnsMotion },
): Promise<string | null> {
  if (!ffmpegAvailable(deps.ffmpegPath)) {
    deps.log?.('FFmpeg not found — skipping Ken Burns fallback.');
    return null;
  }
  const dur = Math.min(Math.max(durationSec, 0.5), deps.maxDurationSec ?? 60);
  const outMp4 = cachePathFor(cacheDir, clipId);
  if (await fileExists(outMp4)) return outMp4; // cache hit
  const { w, h } = canvasSize(format);
  const [c0, c1] = GRADIENT_PALETTES[deps.paletteIndex % GRADIENT_PALETTES.length] ?? GRADIENT_PALETTES[0]!;
  const motion = deps.motion;
  const stillPng = path.join(cacheDir, `${clipId}-still.png`);
  if (!(await fileExists(stillPng))) {
    if (!runFfmpeg(buildGradientStillArgs({ outPng: stillPng, width: w, height: h, c0, c1, ffmpegPath: deps.ffmpegPath }), deps.ffmpegPath, deps.log)) return null;
  }
  const ok = runFfmpeg(
    buildKenBurnsArgs({ imagePath: stillPng, outMp4, durationSec: dur, width: w, height: h, motion, ffmpegPath: deps.ffmpegPath }),
    deps.ffmpegPath,
    deps.log,
  );
  return ok && (await fileExists(outMp4)) ? outMp4 : null;
}

/**
 * REAL: generates (or reuses from cache) a static gradient MP4 — the last
 * resort. Returns the local path, or null when FFmpeg is missing/fails, in
 * which case the caller emits the dependency-free template entry (empty
 * url → buildFrames() colour fallback).
 */
export async function ensureTemplateClip(
  clipId: string,
  durationSec: number,
  format: VideoFormat,
  cacheDir: string,
  deps: LocalGenDeps,
): Promise<string | null> {
  if (!ffmpegAvailable(deps.ffmpegPath)) {
    deps.log?.('FFmpeg not found — using dependency-free template fallback.');
    return null;
  }
  const dur = Math.min(Math.max(durationSec, 0.5), deps.maxDurationSec ?? 60);
  const outMp4 = cachePathFor(cacheDir, clipId);
  if (await fileExists(outMp4)) return outMp4; // cache hit
  const { w, h } = canvasSize(format);
  const idx = createHash('sha256').update(clipId).digest()[0]! % GRADIENT_PALETTES.length;
  const [c0, c1] = GRADIENT_PALETTES[idx] ?? GRADIENT_PALETTES[0]!;
  const ok = runFfmpeg(
    buildTemplateClipArgs({ outMp4, durationSec: dur, width: w, height: h, c0, c1, ffmpegPath: deps.ffmpegPath }),
    deps.ffmpegPath,
    deps.log,
  );
  return ok && (await fileExists(outMp4)) ? outMp4 : null;
}

// ── The cascade ──────────────────────────────────────────────────────

function neededDuration(segment: Segment): number {
  const d = segment.actualDurationSec ?? segment.targetDurationSec;
  return Number.isFinite(d) && d > 0 ? d : 4;
}

function resolveOpts(opts: ResolveBrollOptions): Required<
  Pick<ResolveBrollOptions, 'format' | 'cacheDir' | 'projectDir' | 'requestTimeoutMs' | 'ffmpegPath'>
> & ResolveBrollOptions {
  return {
    ...opts,
    cacheDir: opts.cacheDir ?? defaultCacheDir(),
    projectDir: opts.projectDir ?? process.cwd(),
    requestTimeoutMs: opts.requestTimeoutMs ?? 15_000,
    ffmpegPath: opts.ffmpegPath ?? 'ffmpeg',
  };
}

async function tryApiSource(
  source: 'pexels' | 'pixabay',
  apiKey: string | undefined,
  segment: Segment,
  needed: number,
  registry: UsedClipRegistry,
  o: ReturnType<typeof resolveOpts>,
): Promise<ResolvedBroll | null> {
  if (!apiKey) return null;
  const deps: SearchDeps = { fetchImpl: o.fetchImpl ?? fetch, timeoutMs: o.requestTimeoutMs };
  try {
    const candidates =
      source === 'pexels'
        ? await searchPexels(segment, apiKey, o.format, deps)
        : await searchPixabay(segment, apiKey, o.format, deps);
    const best = selectBestCandidate(candidates, registry.ids, segment, needed, o.format);
    if (!best) {
      o.log?.(`${source}: no unused candidate matched — falling through.`);
      return null;
    }
    const localPath = cachePathFor(o.cacheDir, best.clipId);
    const downloaded = await downloadToCache(best.url, localPath, { ...deps, log: o.log });
    if (!downloaded) return null; // fall through: never hand out a broken clip
    await registry.mark(best.clipId);
    const entry: ResolvedBroll = {
      provider: source,
      clipId: best.clipId,
      url: best.url,
      durationSec: best.durationSec,
      attribution: best.attribution,
      localPath,
    };
    o.log?.(`${source}: resolved ${best.clipId} (${best.durationSec}s) for ${segment.id}.`);
    return entry;
  } catch (err) {
    // Graceful degradation: log and fall through the cascade.
    o.log?.(`${source} failed (${err instanceof Error ? err.message : String(err)}) — falling through.`);
    return null;
  }
}

async function tryKenBurns(
  segment: Segment,
  needed: number,
  registry: UsedClipRegistry,
  o: ReturnType<typeof resolveOpts>,
): Promise<ResolvedBroll | null> {
  const start = kenBurnsVariant(segment.id);
  const variants: Array<{ paletteIndex: number; motion: KenBurnsMotion }> = [];
  for (let i = 0; i < GRADIENT_PALETTES.length; i++) {
    const paletteIndex = (start.paletteIndex + i) % GRADIENT_PALETTES.length;
    variants.push({ paletteIndex, motion: start.motion });
    variants.push({ paletteIndex, motion: start.motion === 'zoom-in' ? 'zoom-out' : 'zoom-in' });
  }
  for (const v of variants) {
    const clipId = clipIdForKenBurns(v.paletteIndex, v.motion, o.format);
    if (registry.has(clipId)) continue;
    const localPath = await ensureKenBurnsClip(clipId, needed, o.format, o.cacheDir, {
      ffmpegPath: o.ffmpegPath,
      log: o.log,
      paletteIndex: v.paletteIndex,
      motion: v.motion,
    });
    if (!localPath) return null; // FFmpeg missing/failed → template fallback
    await registry.mark(clipId);
    o.log?.(`ken-burns: generated ${clipId} (${needed}s) for ${segment.id}.`);
    return { provider: 'image', clipId, url: localPath, localPath, durationSec: needed };
  }
  o.log?.('ken-burns: all variants already used in this project — falling through.');
  return null;
}

async function templateFallback(
  segment: Segment,
  needed: number,
  registry: UsedClipRegistry,
  o: ReturnType<typeof resolveOpts>,
): Promise<ResolvedBroll> {
  // Unique per segment → can never collide with the no-repeat registry.
  const clipId = `template-${segment.id}-${o.format === '9:16' ? '916' : '169'}`;
  const localPath = await ensureTemplateClip(clipId, needed, o.format, o.cacheDir, {
    ffmpegPath: o.ffmpegPath,
    log: o.log,
  });
  if (localPath) {
    await registry.mark(clipId);
    return { provider: 'template', clipId, url: localPath, localPath, durationSec: needed };
  }
  // Dependency-free last resort: empty url → buildFrames() renders the
  // template colour behind the karaoke captions. Still valid visuals.
  return { provider: 'template', clipId, url: '', durationSec: needed };
}

/**
 * Resolves B-roll for ONE segment through the full cascade.
 * NEVER throws for cascade reasons and NEVER returns without a valid
 * broll entry — the worst case is the template fallback.
 */
export async function resolveBroll(segment: Segment, opts: ResolveBrollOptions): Promise<ResolvedBroll> {
  const o = resolveOpts(opts);
  const needed = neededDuration(segment);
  const env = o.env ?? process.env;
  const registry = await UsedClipRegistry.load(o.projectDir);

  const fromPexels = await tryApiSource('pexels', env.PEXELS_API_KEY, segment, needed, registry, o);
  if (fromPexels) return fromPexels;

  const fromPixabay = await tryApiSource('pixabay', env.PIXABAY_API_KEY, segment, needed, registry, o);
  if (fromPixabay) return fromPixabay;

  const kenBurns = await tryKenBurns(segment, needed, registry, o);
  if (kenBurns) return kenBurns;

  return templateFallback(segment, needed, registry, o);
}

/**
 * Resolves B-roll for every segment of a spec (in order) and writes the
 * result into `segment.broll`, ready for buildFrames() / the renderer.
 * Shares one registry across segments, so no clip repeats in the video.
 */
export async function resolveBrollForSegments(
  segments: Segment[],
  opts: ResolveBrollOptions,
): Promise<Segment[]> {
  for (const segment of segments) {
    segment.broll = await resolveBroll(segment, opts);
  }
  return segments;
}
