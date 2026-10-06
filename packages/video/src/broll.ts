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
 *    clips; shorter ones are extended by the short-clip fit — smooth loop
 *    with crossfade by default ('loop'), last-frame hold when the project
 *    opts into 'freeze' (ResolveBrollOptions.shortClipStrategy);
 *  - relevance scoring (scoreCandidate) is synonym-aware: keyword terms
 *    are expanded with curated synonyms/related terms and singular stems,
 *    matched against provider tags ∪ page-URL slug tokens ∪ matched
 *    query tokens; each provider is searched with 2–3 query variants
 *    whose candidates are merged and deduped before scoring.
 *
 * Everything that needs the network or FFmpeg is injectable or guarded so
 * the pure parts (scoring, selection, registry, arg builders) are fully
 * unit-testable.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { BrollProvider, Segment, ShortClipStrategy, VideoFormat } from '@shorts-forge/shared';

// ── Public shapes ────────────────────────────────────────────────────

export type { BrollProvider, ShortClipStrategy };

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
  /**
   * What to do when a stock clip is SHORTER than the segment it must
   * cover. Default: 'loop' (smooth loop with crossfade — the resolved
   * default of the ARCHITECTURE.md §7 open decision). Set to 'freeze'
   * per project to hold the last frame instead. Reversible: the source
   * clip stays untouched in the cache and re-resolving with the other
   * strategy produces a different cached file.
   */
  shortClipStrategy?: ShortClipStrategy | undefined;
}

export type ResolvedBroll = NonNullable<Segment['broll']>;

// ── Scoring ──────────────────────────────────────────────────────────
//
// Scoring v2 — relevance goes beyond raw keyword/tag overlap:
//
//   relevance (55% of total)
//     = 0.70 * weightedOverlap(expanded visualKeywords, candidateText)
//     + 0.30 * weightedOverlap(expanded brollDescription, candidateText)
//
//   where each segment term is expanded to:
//     - the term itself            → weight 1.0
//     - a naive singular stem      → weight 0.9  ("cities" → "city")
//     - curated synonyms/related   → weight 0.7  ("sunrise" → "dawn")
//
//   and each term scores against the candidate's text by best match:
//     exact token equality → 1.0, substring/prefix either way → 0.6,
//     no match → 0.0. The candidate text is the UNION of the provider's
//   own tags (Pixabay), the matched search-query tokens (Pexels, which
//   returns no tags — the engine already did the semantic matching) and
//   tokens scraped from the provider's page-URL slug (both providers,
//   e.g. pixabay.com/videos/sunrise-city-770/).
//
//   durationFit (35%) and orientation (10%) are unchanged from v1:
//   longer clips trim cheaply (1.0 → 0.7 at 2× length); shorter clips
//   score proportionally up to 0.75 (they must be extended, visibly
//   worse than trimming); orientation match is 1.0, mismatch 0.0
//   (0.25 for a portrait clip in a 16:9 video, which crops acceptably).
//
// Why these weights: relevance dominates because a wrong-but-fitting
// clip is worse than a right-but-short one (short clips are now
// extended smoothly by the shortClipStrategy fit); duration matters
// next because trimming is free while extending costs a re-encode;
// orientation is a tiebreaker (the renderer crops anyway).

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

/**
 * Curated English synonyms / closely-related terms for common B-roll
 * subjects. `visualKeywords` from the LLM are ALWAYS English (see
 * ARCHITECTURE.md §2), so a single English map covers every language of
 * narration. Deliberately small and video-oriented — a full thesaurus
 * would add noise; these are terms stock libraries actually tag with.
 */
const SYNONYMS: Record<string, string[]> = {
  sunrise: ['dawn', 'morning', 'daybreak'],
  sunset: ['dusk', 'sundown', 'evening'],
  city: ['urban', 'downtown', 'metropolis', 'skyline', 'cityscape'],
  town: ['village', 'urban'],
  beach: ['seaside', 'coast', 'shore'],
  ocean: ['sea', 'waves', 'water'],
  sea: ['ocean', 'waves', 'water'],
  mountain: ['peak', 'summit', 'hill', 'alps'],
  forest: ['woods', 'trees', 'jungle'],
  river: ['stream', 'water'],
  lake: ['water'],
  waterfall: ['falls', 'water'],
  desert: ['dunes', 'sand'],
  sky: ['clouds'],
  clouds: ['sky'],
  rain: ['rainfall', 'storm', 'drops'],
  snow: ['winter', 'snowfall'],
  storm: ['rain', 'thunder', 'lightning'],
  fire: ['flames', 'blaze', 'bonfire'],
  water: ['ocean', 'sea', 'river', 'drops'],
  coffee: ['espresso', 'cafe'],
  food: ['meal', 'cooking', 'cuisine', 'dish'],
  breakfast: ['morning', 'food', 'coffee'],
  gym: ['workout', 'fitness', 'exercise', 'training'],
  running: ['run', 'jog', 'sprint'],
  yoga: ['meditation', 'mindfulness', 'stretch'],
  meditation: ['mindfulness', 'yoga', 'calm'],
  office: ['workplace', 'business', 'desk', 'work'],
  meeting: ['conference', 'discussion'],
  team: ['group', 'people', 'collaboration'],
  family: ['home', 'parents', 'children'],
  baby: ['infant', 'newborn'],
  dog: ['puppy', 'pet'],
  cat: ['kitten', 'pet'],
  car: ['vehicle', 'automobile', 'drive', 'road'],
  road: ['highway', 'street', 'journey', 'travel'],
  travel: ['journey', 'trip', 'adventure', 'tourism'],
  airplane: ['plane', 'flight', 'airport'],
  business: ['corporate', 'office', 'success'],
  money: ['cash', 'finance', 'wealth', 'investment'],
  phone: ['smartphone', 'mobile', 'call'],
  computer: ['laptop', 'technology', 'screen', 'keyboard'],
  music: ['concert', 'song', 'guitar', 'piano'],
  dance: ['dancing', 'party'],
  wedding: ['bride', 'marriage', 'celebration'],
  party: ['celebration', 'festival', 'event'],
  fireworks: ['celebration', 'night', 'party'],
  night: ['evening', 'dark', 'nightlife'],
  morning: ['dawn', 'sunrise', 'breakfast'],
  garden: ['plants', 'flowers', 'nature'],
  flower: ['bloom', 'blossom', 'garden'],
  tree: ['forest', 'nature', 'woods'],
  bird: ['flying', 'wings', 'nature'],
  crowd: ['people', 'audience', 'gathering'],
  audience: ['crowd', 'people', 'concert'],
  stage: ['concert', 'performance', 'theater'],
  book: ['reading', 'library', 'study'],
  school: ['education', 'classroom', 'learning', 'students'],
  doctor: ['medical', 'hospital', 'health'],
  sport: ['sports', 'game', 'competition', 'athlete'],
  football: ['soccer', 'sport', 'stadium'],
  swimming: ['pool', 'water', 'swim'],
  space: ['stars', 'galaxy', 'cosmos', 'universe'],
  stars: ['night', 'sky', 'space'],
  moon: ['night', 'lunar'],
  sun: ['daylight', 'sunshine', 'bright'],
  light: ['bright', 'glow', 'lamp'],
  timelapse: ['hyperlapse', 'fast', 'motion'],
  aerial: ['drone', 'sky', 'view', 'landscape'],
  drone: ['aerial', 'flight', 'sky'],
  landscape: ['scenery', 'nature', 'view', 'mountains'],
  abstract: ['background', 'pattern', 'texture', 'gradient'],
  background: ['abstract', 'backdrop', 'texture'],
  texture: ['pattern', 'abstract', 'surface'],
  vintage: ['retro', 'old', 'classic'],
  modern: ['contemporary', 'new', 'sleek'],
  luxury: ['elegant', 'premium', 'rich'],
  minimal: ['simple', 'clean', 'minimalism'],
  colorful: ['vibrant', 'vivid', 'colors'],
  portrait: ['face', 'person', 'people'],
};

/** Naive English singularization so plural tags match singular keywords. */
function stem(token: string): string {
  if (token.endsWith('ies') && token.length > 4) return token.slice(0, -3) + 'y';
  if (token.endsWith('es') && token.length > 5 && /(s|x|z|ch|sh)es$/.test(token)) {
    return token.slice(0, -2);
  }
  if (token.endsWith('s') && token.length > 3 && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

interface WeightedTerm {
  term: string;
  weight: number;
}

/** Expands raw tokens into weighted terms (exact 1.0 / stem 0.9 / synonym 0.7). */
function expandTerms(tokens: string[], baseWeight: number): WeightedTerm[] {
  const out: WeightedTerm[] = [];
  const seen = new Set<string>();
  const push = (term: string, weight: number): void => {
    const key = `${term}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ term, weight });
  };
  for (const t of tokens) {
    push(t, baseWeight);
    const s = stem(t);
    if (s !== t) push(s, baseWeight * 0.9);
    for (const syn of SYNONYMS[t] ?? []) push(syn, baseWeight * 0.7);
  }
  return out;
}

/** Best match of one term against the candidate token set. */
function termMatch(term: string, haystack: Set<string>): number {
  if (haystack.has(term)) return 1;
  for (const h of haystack) {
    if (h.startsWith(term) || term.startsWith(h) || h.includes(term) || term.includes(h)) {
      return 0.6;
    }
  }
  return 0;
}

/** Weight-normalized overlap in [0, 1]; 0.5 when there is nothing to match. */
function weightedOverlap(terms: WeightedTerm[], haystack: Set<string>): number {
  let num = 0;
  let den = 0;
  for (const { term, weight } of terms) {
    den += weight;
    num += weight * termMatch(term, haystack);
  }
  return den === 0 ? 0.5 : num / den;
}

/**
 * Descriptive tokens scraped from a provider page URL slug, e.g.
 * "https://pixabay.com/videos/sunrise-city-skyline-770/" → sunrise, city,
 * skyline. Pure numeric path segments (ids) and short tokens are dropped.
 * Both Pexels and Pixabay page URLs carry these slugs, so this is free
 * provider metadata the raw tag lists miss.
 */
export function tokensFromPageUrl(pageUrl: string): string[] {
  let path = '';
  try {
    path = new URL(pageUrl).pathname;
  } catch {
    path = pageUrl;
  }
  return path
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/** The full text signal for a candidate: tags ∪ page-slug tokens. */
function candidateTextTokens(candidate: BrollCandidate): Set<string> {
  return new Set([...candidate.tags.flatMap(tokenize), ...tokensFromPageUrl(candidate.pageUrl)]);
}

/**
 * Scores one candidate for a segment. See the "Scoring v2" block comment
 * above for the documented formula.
 */
export function scoreCandidate(
  candidate: BrollCandidate,
  segment: Pick<Segment, 'visualKeywords' | 'brollDescription'>,
  neededSec: number,
  format: VideoFormat,
): CandidateScore {
  const text = candidateTextTokens(candidate);
  const kwTokens = segment.visualKeywords.flatMap(tokenize);
  const descTokens = tokenize(segment.brollDescription);
  const kwScore = weightedOverlap(expandTerms(kwTokens, 1), text);
  const descScore = weightedOverlap(expandTerms(descTokens, 1), text);
  const relevance = 0.7 * kwScore + 0.3 * descScore;

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

/**
 * Builds 2–3 query variants for one segment so multi-query merging can
 * widen recall before scoring narrows it back down:
 *   1. primary: the top-3 visual keywords (as buildSearchQuery);
 *   2. synonym variant: each keyword swapped for its first known synonym
 *      (e.g. "sunrise city timelapse" → "dawn urban hyperlapse");
 *   3. description-led: top tokens of brollDescription (a different angle
 *      on the same shot, often phrased like a stock-library caption).
 * Variants that collapse to the primary (no synonyms known, description
 * already covered) are dropped, so a segment with no expansion data still
 * yields exactly one query — never an empty or duplicate one.
 */
export function buildQueryVariants(
  segment: Pick<Segment, 'visualKeywords' | 'brollDescription'>,
): string[] {
  const primary = buildSearchQuery(segment);
  const variants = [primary];
  const kws = segment.visualKeywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (kws.length > 0) {
    const synQuery = kws
      .slice(0, 3)
      .map((k) => SYNONYMS[k]?.[0] ?? k)
      .join(' ');
    if (synQuery !== primary && !variants.includes(synQuery)) variants.push(synQuery);
  }
  const descQuery = tokenize(segment.brollDescription).slice(0, 4).join(' ');
  if (descQuery !== '' && descQuery !== primary && !variants.includes(descQuery)) {
    variants.push(descQuery);
  }
  return variants.slice(0, 3);
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

export interface SearchQueryOptions {
  /** Override the query built from the segment (used by multi-query variants). */
  query?: string | undefined;
  /** Results per variant. Default 15 (first variant), 10 (later variants). */
  perPage?: number | undefined;
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
  queryOpts?: SearchQueryOptions,
): Promise<BrollCandidate[]> {
  const query = queryOpts?.query ?? buildSearchQuery(segment);
  const params = new URLSearchParams({
    query,
    orientation: format === '9:16' ? 'portrait' : 'landscape',
    size: 'medium',
    per_page: String(queryOpts?.perPage ?? 15),
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
      // Pexels returns no tags; the matched query tokens are the signal
      // (plus page-slug tokens, picked up at scoring time).
      tags: tokenize(query),
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
  queryOpts?: SearchQueryOptions,
): Promise<BrollCandidate[]> {
  const query = queryOpts?.query ?? buildSearchQuery(segment);
  const params = new URLSearchParams({
    key: apiKey,
    q: query,
    per_page: String(queryOpts?.perPage ?? 15),
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

// ── Multi-query merging ──────────────────────────────────────────────

/**
 * Runs every query variant from buildQueryVariants() against one
 * provider, merges the candidate lists and dedupes by clipId (unioning
 * tags, so a clip found by two variants keeps both query signals).
 * Variants run sequentially to stay gentle on free-tier quotas; the
 * later variants ask for fewer results (10 vs 15) for the same reason.
 *
 * Failure semantics: a failure on the FIRST variant throws (auth errors
 * and outages must fail fast so the cascade falls through to the next
 * provider); a failure on a LATER variant keeps the candidates gathered
 * so far (a 429 mid-way degrades recall, never the whole provider).
 */
async function searchMultiVariant(
  segment: Pick<Segment, 'visualKeywords' | 'brollDescription'>,
  searchOne: (query: string, perPage: number) => Promise<BrollCandidate[]>,
): Promise<BrollCandidate[]> {
  const variants = buildQueryVariants(segment);
  const byId = new Map<string, BrollCandidate>();
  for (let i = 0; i < variants.length; i++) {
    const query = variants[i]!;
    let cands: BrollCandidate[];
    try {
      cands = await searchOne(query, i === 0 ? 15 : 10);
    } catch (err) {
      if (i === 0) throw err;
      break; // later variant failed (e.g. 429): keep what we have
    }
    for (const c of cands) {
      const prev = byId.get(c.clipId);
      if (prev) {
        prev.tags = [...new Set([...prev.tags, ...c.tags])];
      } else {
        byId.set(c.clipId, c);
      }
    }
  }
  return [...byId.values()];
}

/** Multi-query Pexels search: variants merged + deduped (see searchMultiVariant). */
export async function searchPexelsMulti(
  segment: Pick<Segment, 'visualKeywords' | 'brollDescription'>,
  apiKey: string,
  format: VideoFormat,
  deps: SearchDeps,
): Promise<BrollCandidate[]> {
  return searchMultiVariant(segment, (query, perPage) =>
    searchPexels(segment, apiKey, format, deps, { query, perPage }),
  );
}

/** Multi-query Pixabay search: variants merged + deduped (see searchMultiVariant). */
export async function searchPixabayMulti(
  segment: Pick<Segment, 'visualKeywords' | 'brollDescription'>,
  apiKey: string,
  format: VideoFormat,
  deps: SearchDeps,
): Promise<BrollCandidate[]> {
  return searchMultiVariant(segment, (query, perPage) =>
    searchPixabay(segment, apiKey, format, deps, { query, perPage }),
  );
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

// ── Short-clip fit: loop-with-crossfade (default) / freeze ──────────
//
// Resolves the ARCHITECTURE.md §7 deferred decision: when a stock clip
// is SHORTER than its segment, the default is a SMOOTH LOOP WITH
// CROSSFADE ('loop'), configurable per project to 'freeze' via
// ResolveBrollOptions.shortClipStrategy. Never time-stretch (artefacts).
// The source clip stays untouched in the cache; the fitted clip is a
// deterministic cache derivative, so the choice is fully reversible by
// re-resolving with the other strategy.

/** Gaps smaller than this are not worth a re-encode. */
const SHORT_CLIP_EPS = 0.05;

function fmtSec(n: number): string {
  return String(parseFloat(n.toFixed(3)));
}

/**
 * Builds the FFmpeg args for a smooth loop with crossfade. Pure.
 *
 * Technique: the clip is repeated `repeats` times; consecutive copies
 * are joined with xfade (fade transition). The fade duration is
 * min(0.5s, clipDur/4) — long enough to hide the loop point, short
 * enough to never eat the clip. Offsets are cumulative:
 *   offset_k = k * clipDur - k * fadeDur   (k = 1..repeats-1)
 * so each joint lands exactly at a copy boundary minus the fade.
 * The chain is trimmed to exactly targetDurationSec.
 * Audio is dropped (-an): B-roll always plays muted in the composition.
 */
export function buildSmoothLoopArgs(opts: {
  inputPath: string;
  outPath: string;
  clipDurationSec: number;
  targetDurationSec: number;
  fps?: number;
  ffmpegPath?: string;
}): string[] {
  const ff = opts.ffmpegPath ?? 'ffmpeg';
  const fps = opts.fps ?? 30;
  const d = opts.clipDurationSec;
  const T = opts.targetDurationSec;
  const fade = Math.min(0.5, d / 4);
  const repeats = Math.max(2, Math.ceil((T - fade) / (d - fade)));

  const splits = Array.from({ length: repeats }, (_, i) => `[s${i}]`).join('');
  let chain = `[0:v]fps=${fps},format=yuv420p,split=${repeats}${splits}`;
  let prev = '[s0]';
  for (let k = 1; k < repeats; k++) {
    const offset = fmtSec(k * d - k * fade);
    const out = k === repeats - 1 ? '[xfin]' : `[x${k}]`;
    chain += `;${prev}[s${k}]xfade=transition=fade:duration=${fmtSec(fade)}:offset=${offset}${out}`;
    prev = out;
  }
  chain += `;[xfin]trim=0:${fmtSec(T)},setpts=PTS-STARTPTS,format=yuv420p[vout]`;

  return [
    ff, '-y',
    '-i', opts.inputPath,
    '-filter_complex', chain,
    '-map', '[vout]',
    '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-movflags', '+faststart',
    opts.outPath,
  ];
}

/**
 * Builds the FFmpeg args for a freeze fit: the clip plays once, then its
 * LAST frame is held (tpad stop_mode=clone) for the missing time, up to
 * exactly targetDurationSec. Pure. Audio is dropped (-an), same as loop.
 */
export function buildFreezeFrameArgs(opts: {
  inputPath: string;
  outPath: string;
  clipDurationSec: number;
  targetDurationSec: number;
  fps?: number;
  ffmpegPath?: string;
}): string[] {
  const ff = opts.ffmpegPath ?? 'ffmpeg';
  const fps = opts.fps ?? 30;
  const gap = Math.max(0, opts.targetDurationSec - opts.clipDurationSec);
  const vf =
    `fps=${fps},tpad=stop_mode=clone:stop_duration=${fmtSec(gap)},` +
    `format=yuv420p`;
  return [
    ff, '-y',
    '-i', opts.inputPath,
    '-vf', vf,
    '-t', fmtSec(opts.targetDurationSec),
    '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-movflags', '+faststart',
    opts.outPath,
  ];
}

export interface FitShortClipDeps {
  ffmpegPath: string;
  log?: ((m: string) => void) | undefined;
  fps?: number;
}

/**
 * REAL: extends a too-short stock clip to `neededSec` with FFmpeg —
 * 'loop' (default) chains crossfaded repetitions, 'freeze' holds the
 * last frame. The fitted clip is cached deterministically
 * (`fit-<strategy>-<clipId>-<needed>s.mp4`) and returned with the honest
 * duration (== neededSec).
 *
 * Returns null on ANY failure (FFmpeg missing/broken, degenerate
 * durations) — the caller then keeps the original short clip with its
 * honest duration, so the never-empty cascade guarantee holds.
 */
export async function fitShortClip(
  clipPath: string,
  clipDurationSec: number,
  neededSec: number,
  strategy: ShortClipStrategy,
  cacheDir: string,
  baseClipId: string,
  deps: FitShortClipDeps,
): Promise<{ localPath: string; durationSec: number } | null> {
  try {
    if (!ffmpegAvailable(deps.ffmpegPath)) {
      deps.log?.('FFmpeg not found — keeping the short clip as-is.');
      return null;
    }
    const d = clipDurationSec;
    const T = neededSec;
    if (!(d > 0.2) || !(T > d + SHORT_CLIP_EPS)) return null;
    const outPath = cachePathFor(cacheDir, `fit-${strategy}-${baseClipId}-${T.toFixed(1)}s`);
    if (await fileExists(outPath)) return { localPath: outPath, durationSec: T }; // cache hit
    const fps = deps.fps ?? 30;
    const args =
      strategy === 'loop'
        ? buildSmoothLoopArgs({ inputPath: clipPath, outPath, clipDurationSec: d, targetDurationSec: T, fps, ffmpegPath: deps.ffmpegPath })
        : buildFreezeFrameArgs({ inputPath: clipPath, outPath, clipDurationSec: d, targetDurationSec: T, fps, ffmpegPath: deps.ffmpegPath });
    if (!runFfmpeg(args, deps.ffmpegPath, deps.log)) return null;
    if (!(await fileExists(outPath))) return null;
    return { localPath: outPath, durationSec: T };
  } catch (err) {
    deps.log?.(`short-clip fit (${strategy}) failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
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
        ? await searchPexelsMulti(segment, apiKey, o.format, deps)
        : await searchPixabayMulti(segment, apiKey, o.format, deps);
    const best = selectBestCandidate(candidates, registry.ids, segment, needed, o.format);
    if (!best) {
      o.log?.(`${source}: no unused candidate matched — falling through.`);
      return null;
    }
    const basePath = cachePathFor(o.cacheDir, best.clipId);
    const downloaded = await downloadToCache(best.url, basePath, { ...deps, log: o.log });
    if (!downloaded) return null; // fall through: never hand out a broken clip
    await registry.mark(best.clipId);

    // Clip shorter than the segment? Extend it (default: smooth loop with
    // crossfade). A failed fit falls back to the honest short clip —
    // never empty, never stretched.
    let localPath = basePath;
    let durationSec = best.durationSec;
    let shortClipStrategy: ShortClipStrategy | undefined;
    const strategy: ShortClipStrategy = o.shortClipStrategy ?? 'loop';
    if (best.durationSec < needed - SHORT_CLIP_EPS) {
      const fit = await fitShortClip(basePath, best.durationSec, needed, strategy, o.cacheDir, best.clipId, {
        ffmpegPath: o.ffmpegPath,
        log: o.log,
      });
      if (fit) {
        localPath = fit.localPath;
        durationSec = fit.durationSec;
        shortClipStrategy = strategy;
        o.log?.(`${source}: short clip ${best.clipId} extended via ${strategy} to ${durationSec.toFixed(1)}s.`);
      } else {
        o.log?.(`${source}: short-clip fit (${strategy}) failed for ${best.clipId} — keeping the short clip as-is.`);
      }
    }

    const entry: ResolvedBroll = {
      provider: source,
      clipId: best.clipId,
      url: best.url,
      durationSec,
      attribution: best.attribution,
      localPath,
      ...(shortClipStrategy !== undefined ? { shortClipStrategy } : {}),
    };
    o.log?.(`${source}: resolved ${best.clipId} (${durationSec.toFixed(1)}s) for ${segment.id}.`);
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
