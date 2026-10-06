/**
 * Tests for the B-roll resolution module (packages/video/src/broll.ts).
 *
 * - scoring/selection: pure, fully deterministic;
 * - no-repeat registry: in-memory + JSON persistence;
 * - cascade fallback order: HTTP layer mocked via injected fetchImpl;
 * - cache hit/miss: real files in a temp dir;
 * - one LIVE test per API, guarded by key presence (skips with a clear
 *   reason when no key — never faked).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Segment } from '@shorts-forge/shared';
import {
  buildGradientStillArgs,
  buildKenBurnsArgs,
  buildSearchQuery,
  buildTemplateClipArgs,
  cachePathFor,
  clipIdForKenBurns,
  downloadToCache,
  ensureKenBurnsClip,
  ffmpegAvailable,
  kenBurnsVariant,
  resolveBroll,
  resolveBrollForSegments,
  scoreCandidate,
  searchPexels,
  searchPixabay,
  selectBestCandidate,
  UsedClipRegistry,
  type BrollCandidate,
} from '../broll.js';
import { buildFrames } from '../frames.js';

function segment(over: Partial<Segment> = {}): Segment {
  return {
    id: 'seg-01',
    narration: 'O sol nasce sobre a cidade.',
    visualKeywords: ['sunrise', 'city', 'timelapse'],
    brollDescription: 'Timelapse of a sunrise over a city skyline',
    targetDurationSec: 5,
    actualDurationSec: 5.2,
    ...over,
  };
}

function candidate(over: Partial<BrollCandidate> = {}): BrollCandidate {
  return {
    provider: 'pexels',
    clipId: 'pexels-1',
    url: 'https://example.com/v1.mp4',
    pageUrl: 'https://example.com/p1',
    durationSec: 6,
    width: 1080,
    height: 1920,
    tags: ['sunrise', 'city', 'skyline'],
    attribution: 'Video from Pexels',
    ...over,
  };
}

// ── scoring ──────────────────────────────────────────────────────────

test('scoreCandidate: keyword/tag overlap ranks higher', () => {
  const seg = segment();
  const good = candidate({ clipId: 'pexels-1', tags: ['sunrise', 'city', 'timelapse'] });
  const bad = candidate({ clipId: 'pexels-2', tags: ['ocean', 'waves', 'surf'] });
  const sGood = scoreCandidate(good, seg, 5.2, '9:16');
  const sBad = scoreCandidate(bad, seg, 5.2, '9:16');
  assert.ok(sGood.total > sBad.total, `expected ${sGood.total} > ${sBad.total}`);
  assert.ok(sGood.relevance > sBad.relevance);
});

test('scoreCandidate: exact duration fit beats too-short and too-long', () => {
  const seg = segment({ visualKeywords: ['city'], brollDescription: 'city' });
  const tags = ['city'];
  const exact = candidate({ clipId: 'a', durationSec: 5.2, tags });
  const longer = candidate({ clipId: 'b', durationSec: 20, tags });
  const shorter = candidate({ clipId: 'c', durationSec: 2.6, tags });
  const sExact = scoreCandidate(exact, seg, 5.2, '9:16');
  const sLonger = scoreCandidate(longer, seg, 5.2, '9:16');
  const sShorter = scoreCandidate(shorter, seg, 5.2, '9:16');
  assert.ok(sExact.durationFit > sLonger.durationFit, 'exact should beat much-longer');
  assert.ok(sExact.durationFit > sShorter.durationFit, 'exact should beat too-short');
  assert.ok(sLonger.durationFit > sShorter.durationFit, 'longer (trimmable) should beat shorter (loops)');
});

test('scoreCandidate: portrait preferred for 9:16, landscape for 16:9', () => {
  const seg = segment();
  const portrait = candidate({ clipId: 'p', width: 1080, height: 1920 });
  const landscape = candidate({ clipId: 'l', width: 1920, height: 1080 });
  const v = scoreCandidate(portrait, seg, 5.2, '9:16');
  const h = scoreCandidate(landscape, seg, 5.2, '9:16');
  assert.equal(v.orientation, 1);
  assert.equal(h.orientation, 0);
  assert.ok(v.total > h.total);
  const hl = scoreCandidate(landscape, seg, 5.2, '16:9');
  assert.equal(hl.orientation, 1);
});

test('selectBestCandidate: skips used clip ids, returns null when all used', () => {
  const seg = segment();
  const cands = [candidate({ clipId: 'pexels-1' }), candidate({ clipId: 'pexels-2' })];
  const used = new Set(['pexels-1', 'pexels-2']);
  assert.equal(selectBestCandidate(cands, used, seg, 5.2, '9:16'), null);
  const usedOne = new Set(['pexels-1']);
  assert.equal(selectBestCandidate(cands, usedOne, seg, 5.2, '9:16')?.clipId, 'pexels-2');
});

test('buildSearchQuery: keywords first, description fallback', () => {
  assert.equal(buildSearchQuery(segment()), 'sunrise city timelapse');
  const noKw = segment({ visualKeywords: [] });
  assert.ok(buildSearchQuery(noKw).length > 0);
});

// ── registry ─────────────────────────────────────────────────────────

test('UsedClipRegistry: mark/has + JSON persistence across loads', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sf-reg-'));
  const reg = await UsedClipRegistry.load(dir);
  assert.equal(reg.has('pexels-1'), false);
  await reg.mark('pexels-1');
  assert.equal(reg.has('pexels-1'), true);

  const raw = JSON.parse(await readFile(path.join(dir, 'broll-registry.json'), 'utf8')) as {
    usedClipIds: string[];
  };
  assert.ok(raw.usedClipIds.includes('pexels-1'));

  const reg2 = await UsedClipRegistry.load(dir);
  assert.equal(reg2.has('pexels-1'), true, 'registry must survive reload');
  assert.equal(reg2.has('pexels-2'), false);
});

test('UsedClipRegistry: corrupt/missing file starts empty, never throws', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sf-reg-'));
  await writeFile(path.join(dir, 'broll-registry.json'), 'not-json{{{', 'utf8');
  const reg = await UsedClipRegistry.load(dir);
  assert.equal(reg.has('anything'), false);
  await reg.mark('x'); // must still persist fine afterwards
  assert.equal(reg.has('x'), true);
});

// ── mocked HTTP cascade ──────────────────────────────────────────────

function pexelsBody(videos: Array<Record<string, unknown>>): unknown {
  return { videos };
}
function pixabayBody(hits: Array<Record<string, unknown>>): unknown {
  return { totalHits: hits.length, hits };
}

/** Mock fetch that serves canned API payloads and fake video bytes. */
function mockFetch(handler: (url: string) => { status: number; body: unknown } | Error): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const outcome = handler(url);
    if (outcome instanceof Error) throw outcome;
    const { status, body } = outcome;
    const isJson = typeof body !== 'string' || body.startsWith('{');
    const bytes = typeof body === 'string' && !isJson ? body : JSON.stringify(body);
    return new Response(bytes, {
      status,
      headers: { 'content-type': isJson ? 'application/json' : 'video/mp4' },
    });
  }) as typeof fetch;
}

async function freshDirs(): Promise<{ cacheDir: string; projectDir: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'sf-broll-'));
  const cacheDir = path.join(base, 'cache');
  const projectDir = path.join(base, 'project');
  await mkdir(cacheDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  return { cacheDir, projectDir };
}

const PEXELS_VIDEO = {
  id: 3121459,
  width: 1080,
  height: 1920,
  duration: 8,
  url: 'https://www.pexels.com/video/3121459/',
  video_files: [
    { id: 1, quality: 'hd', file_type: 'video/mp4', width: 1080, height: 1920, link: 'https://cdn.example/v3121459.mp4' },
    { id: 2, quality: 'sd', file_type: 'video/mp4', width: 540, height: 960, link: 'https://cdn.example/v3121459-sd.mp4' },
  ],
};

test('cascade: Pexels wins when key present and API healthy', async () => {
  const { cacheDir, projectDir } = await freshDirs();
  const fetchImpl = mockFetch((url) => {
    if (url.includes('api.pexels.com')) return { status: 200, body: pexelsBody([PEXELS_VIDEO]) };
    if (url.includes('cdn.example')) return { status: 200, body: 'FAKEVIDEO' };
    return { status: 404, body: {} };
  });
  const broll = await resolveBroll(segment(), {
    format: '9:16',
    cacheDir,
    projectDir,
    fetchImpl,
    env: { PEXELS_API_KEY: 'k', PIXABAY_API_KEY: 'k2' },
  });
  assert.equal(broll.provider, 'pexels');
  assert.equal(broll.clipId, 'pexels-3121459');
  assert.equal(broll.url, 'https://cdn.example/v3121459.mp4');
  assert.equal(broll.durationSec, 8); // honest duration, renderer trims
  assert.ok(broll.localPath);
  assert.equal(await stat(broll.localPath).then((s) => s.size > 0), true);
});

test('cascade: Pexels failure falls through to Pixabay', async () => {
  const { cacheDir, projectDir } = await freshDirs();
  const hit = {
    id: 770,
    pageURL: 'https://pixabay.com/videos/770/',
    duration: 10,
    tags: 'sunrise, city, skyline',
    user: 'tester',
    videos: { medium: { url: 'https://cdn.px.example/770.mp4', width: 1280, height: 720 } },
  };
  const fetchImpl = mockFetch((url) => {
    if (url.includes('api.pexels.com')) return new Error('socket hangup');
    if (url.includes('pixabay.com')) return { status: 200, body: pixabayBody([hit]) };
    if (url.includes('cdn.px.example')) return { status: 200, body: 'FAKEVIDEO' };
    return { status: 404, body: {} };
  });
  const broll = await resolveBroll(segment(), {
    format: '9:16',
    cacheDir,
    projectDir,
    fetchImpl,
    env: { PEXELS_API_KEY: 'k', PIXABAY_API_KEY: 'k2' },
  });
  assert.equal(broll.provider, 'pixabay');
  assert.equal(broll.clipId, 'pixabay-770');
  assert.equal(broll.attribution, 'Video by tester from Pixabay');
});

test('cascade: no keys at all → Ken Burns (real FFmpeg clip)', async (t) => {
  if (!ffmpegAvailable()) {
    t.skip('ffmpeg não disponível — fallback Ken Burns não testável aqui');
    return;
  }
  const { cacheDir, projectDir } = await freshDirs();
  const fetchImpl = mockFetch(() => {
    throw new Error('fetch must not be called without keys');
  });
  const seg = segment({ actualDurationSec: 2.5 });
  const broll = await resolveBroll(seg, { format: '9:16', cacheDir, projectDir, fetchImpl, env: {} });
  assert.equal(broll.provider, 'image');
  assert.ok(broll.clipId.startsWith('kb-p'));
  assert.ok(broll.localPath);
  assert.equal(broll.durationSec, 2.5);
  assert.equal(await stat(broll.localPath).then((s) => s.size > 0), true);
  // The clip is a real 1080x1920 MP4 — probe it.
  const { spawnSync } = await import('node:child_process');
  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,duration', '-of', 'csv=p=0',
    broll.localPath,
  ], { encoding: 'utf8' });
  assert.equal(probe.status, 0);
  assert.match(String(probe.stdout), /1080,1920/);
});

test('cascade: everything broken + no FFmpeg → template entry with colour fallback', async () => {
  const { cacheDir, projectDir } = await freshDirs();
  const fetchImpl = mockFetch(() => {
    throw new Error('network down');
  });
  const broll = await resolveBroll(segment(), {
    format: '9:16',
    cacheDir,
    projectDir,
    fetchImpl,
    env: { PEXELS_API_KEY: 'k' },
    ffmpegPath: '/nonexistent/ffmpeg-binary',
  });
  assert.equal(broll.provider, 'template');
  assert.equal(broll.url, '');
  assert.ok(broll.durationSec > 0);
  // buildFrames() must still produce a valid frame (colour fallback).
  const built = buildFrames(
    { version: 1, title: 't', format: '9:16', language: 'pt-PT', segments: [{ ...segment(), broll }] },
    'bold-social',
  );
  assert.equal(built.frames[0]?.background.kind, 'color');
});

test('no-repeat: same candidate never reused across segments of one project', async () => {
  const { cacheDir, projectDir } = await freshDirs();
  const fetchImpl = mockFetch((url) => {
    if (url.includes('api.pexels.com')) return { status: 200, body: pexelsBody([PEXELS_VIDEO]) };
    if (url.includes('cdn.example')) return { status: 200, body: 'FAKEVIDEO' };
    return { status: 404, body: {} };
  });
  const segs = [
    segment({ id: 'seg-01' }),
    segment({ id: 'seg-02' }),
    segment({ id: 'seg-03' }),
  ];
  const env = { PEXELS_API_KEY: 'k' };
  const opts = { format: '9:16' as const, cacheDir, projectDir, fetchImpl, env };
  await resolveBrollForSegments(segs, opts);
  const ids = segs.map((s) => s.broll?.clipId);
  assert.equal(new Set(ids).size, ids.length, `clip ids must be unique: ${ids.join(',')}`);
  assert.equal(segs[0]?.broll?.clipId, 'pexels-3121459');
  // Later segments fell through (single candidate) without crashing.
  for (const s of segs) assert.ok(s.broll, `${s.id} must always have broll`);
});

test('cache: second resolve reuses the cached file, no re-download', async () => {
  const { cacheDir, projectDir } = await freshDirs();
  let downloads = 0;
  const fetchImpl = mockFetch((url) => {
    if (url.includes('api.pexels.com')) return { status: 200, body: pexelsBody([PEXELS_VIDEO]) };
    if (url.includes('cdn.example')) {
      downloads += 1;
      return { status: 200, body: 'FAKEVIDEO' };
    }
    return { status: 404, body: {} };
  });
  const opts = {
    format: '9:16' as const,
    cacheDir,
    projectDir,
    fetchImpl,
    env: { PEXELS_API_KEY: 'k' },
  };
  // Use a FRESH registry each time (new project) but the SAME cache dir:
  // the download must happen exactly once.
  const dir2 = await mkdtemp(path.join(tmpdir(), 'sf-broll-'));
  await resolveBroll(segment(), { ...opts, projectDir: dir2 });
  await resolveBroll(segment(), { ...opts, projectDir: await mkdtemp(path.join(tmpdir(), 'sf-broll-')) });
  assert.equal(downloads, 1, 'video file must be downloaded exactly once');
});

test('downloadToCache: HTTP error returns false, never throws', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sf-broll-'));
  const dest = path.join(dir, 'x.mp4');
  const fetchImpl = mockFetch(() => ({ status: 429, body: {} }));
  const ok = await downloadToCache('https://cdn.example/x.mp4', dest, {
    fetchImpl,
    timeoutMs: 5_000,
    log: () => {},
  });
  assert.equal(ok, false);
});

// ── FFmpeg arg builders (pure) ───────────────────────────────────────

test('buildGradientStillArgs: renders a deterministic gradients command', () => {
  const args = buildGradientStillArgs({ outPng: '/tmp/s.png', width: 1080, height: 1920, c0: '0d1b2a', c1: '1b4f72' });
  assert.equal(args[0], 'ffmpeg');
  assert.ok(args.includes('gradients=size=1080x1920:c0=0x0d1b2a:c1=0x1b4f72:speed=0'));
  assert.ok(args.includes('/tmp/s.png'));
});

test('buildKenBurnsArgs: zoompan covers the full duration', () => {
  const args = buildKenBurnsArgs({
    imagePath: '/tmp/s.png', outMp4: '/tmp/kb.mp4', durationSec: 4, width: 1080, height: 1920, motion: 'zoom-in',
  });
  const vf = args[args.indexOf('-vf') + 1] ?? '';
  assert.match(vf, /zoompan=/);
  assert.match(vf, /d=120/); // 4s * 30fps
  assert.match(vf, /s=1080x1920/);
  assert.ok(args.includes('-frames:v') && args[args.indexOf('-frames:v') + 1] === '120');
});

test('buildTemplateClipArgs: static gradient for the full duration', () => {
  const args = buildTemplateClipArgs({ outMp4: '/tmp/t.mp4', durationSec: 2.5, width: 1920, height: 1080, c0: 'aa', c1: 'bb' });
  assert.ok(args.includes('gradients=size=1920x1080:c0=0xaa:c1=0xbb:speed=0'));
  assert.ok(args[args.indexOf('-frames:v') + 1] === '75'); // 2.5s * 30fps
});

test('kenBurnsVariant: deterministic per segment id', () => {
  const a = kenBurnsVariant('seg-01');
  const b = kenBurnsVariant('seg-01');
  assert.deepEqual(a, b);
  assert.ok(a.paletteIndex >= 0 && a.paletteIndex < 5);
});

test('clipIdForKenBurns: namespaced and format-aware', () => {
  assert.equal(clipIdForKenBurns(2, 'zoom-in', '9:16'), 'kb-p2-zoom-in-916');
  assert.equal(clipIdForKenBurns(0, 'zoom-out', '16:9'), 'kb-p0-zoom-out-169');
});

test('cachePathFor: deterministic and sanitized', () => {
  assert.equal(cachePathFor('/c', 'pexels-3121459'), path.join('/c', 'pexels-3121459.mp4'));
  assert.equal(cachePathFor('/c', 'a/b:c'), path.join('/c', 'a-b-c.mp4'));
});

test('ensureKenBurnsClip: returns null (not throw) when FFmpeg missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sf-broll-'));
  const out = await ensureKenBurnsClip('kb-x', 2, '9:16', dir, {
    ffmpegPath: '/nonexistent/ffmpeg-binary',
    paletteIndex: 0,
    motion: 'zoom-in',
    log: () => {},
  });
  assert.equal(out, null);
});

// ── LIVE tests (guarded by key presence — never faked) ───────────────

test('LIVE: Pexels search returns real candidates', { skip: process.env.PEXELS_API_KEY ? false : 'sem PEXELS_API_KEY no ambiente — teste ao vivo ignorado (não simulado)' }, async () => {
  const cands = await searchPexels(
    segment(),
    process.env.PEXELS_API_KEY as string,
    '9:16',
    { fetchImpl: fetch, timeoutMs: 20_000 },
  );
  assert.ok(cands.length > 0, 'Pexels should return candidates for "sunrise city timelapse"');
  assert.ok(cands[0]?.url.startsWith('https://'), 'candidate must carry a direct file URL');
});

test('LIVE: Pixabay search returns real candidates', { skip: process.env.PIXABAY_API_KEY ? false : 'sem PIXABAY_API_KEY no ambiente — teste ao vivo ignorado (não simulado)' }, async () => {
  const cands = await searchPixabay(
    segment(),
    process.env.PIXABAY_API_KEY as string,
    '9:16',
    { fetchImpl: fetch, timeoutMs: 20_000 },
  );
  assert.ok(cands.length > 0, 'Pixabay should return candidates for "sunrise city timelapse"');
  assert.ok(cands[0]?.url.startsWith('https://'), 'candidate must carry a direct file URL');
});
