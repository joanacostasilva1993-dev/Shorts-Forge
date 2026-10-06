/**
 * Canonical shared types for shorts-forge.
 *
 * These types are the contract between all packages (llm-router, pipeline,
 * transcription, tts, video, ui). Do NOT change them without cross-team
 * agreement — every module builds on these exact shapes.
 *
 * Units: durations are in seconds, timestamps are in seconds.
 * TSDoc is in English; user-facing docs live in pt-PT elsewhere.
 */

/**
 * A single word with word-level timestamps, in seconds.
 * Produced by the transcription service (faster-whisper) and by TTS (Kokoro).
 */
export interface Word {
  word: string;
  start: number;
  end: number;
}

/** Output video aspect: vertical short or horizontal long-form. */
export type VideoFormat = '9:16' | '16:9';

/**
 * Platform presets for the render target. A preset bundles resolution,
 * caption safe areas, loudness target and platform quirks; it always
 * implies a `VideoFormat` (see `packages/video/src/presets.ts`).
 */
export type PlatformPresetId =
  | 'tiktok'
  | 'youtube-shorts'
  | 'youtube-long'
  | 'instagram-reels';

/**
 * Caption/text safe area as fractions (0–1) of the canvas — insets that
 * keep burned-in text clear of platform UI overlays (action rails,
 * progress bars, top status bars). Fractions scale with the canvas, so
 * the same preset works for the full-res render and the low-res preview.
 */
export interface SafeArea {
  /** Top inset (status bar, search/close buttons). */
  top: number;
  /** Right inset (like/comment/share action rail on vertical video). */
  right: number;
  /** Bottom inset (progress bar, title/channel overlay, nav bar). */
  bottom: number;
  /** Left inset (usually small). */
  left: number;
}

/**
 * Where a resolved B-roll clip comes from:
 *  - 'pexels' | 'pixabay': stock video via the provider's free API tier;
 *  - 'image': Ken Burns clip (slow zoom/pan) generated locally with FFmpeg;
 *  - 'template': gradient background generated locally (last resort).
 */
export type BrollProvider = 'pexels' | 'pixabay' | 'image' | 'template';

/**
 * What to do when a resolved B-roll clip is SHORTER than the segment it
 * has to cover (ARCHITECTURE.md §7 — the deferred montage decision,
 * resolved: 'loop' is the default).
 *  - 'loop': extend the clip by looping it with a smooth crossfade
 *    between repetitions (FFmpeg xfade) — the default;
 *  - 'freeze': extend the clip by holding its last frame (FFmpeg tpad
 *    clone) for the missing time.
 * Never time-stretch: stretching creates visible artefacts.
 */
export type ShortClipStrategy = 'loop' | 'freeze';

/**
 * One timed shot of the final video.
 *
 * A Segment starts life as a plan (Phase A: LLM output) — id, narration,
 * visualKeywords, brollDescription and targetDurationSec are set then.
 * Phase B fills in the runtime data: tts (from real TTS word timestamps),
 * broll (resolved clip) and actualDurationSec (measured after re-timing).
 */
export interface Segment {
  /** Stable identifier, unique within a Spec (e.g. "seg-01"). */
  id: string;
  /** Narration text spoken in this shot (pt-PT for the default voice). */
  narration: string;
  /** Search keywords used to find matching B-roll footage. */
  visualKeywords: string[];
  /** Plain-language description of the desired B-roll shot. */
  brollDescription: string;
  /** Planned duration in seconds (Phase A estimate). */
  targetDurationSec: number;
  /** 0–1 score of how strong a hook this shot is (optional, Phase A). */
  hookScore?: number;
  /** Suggested on-screen hook text (optional, Phase A). */
  hookLine?: string;
  /** TTS audio produced for this shot's narration (Phase B). */
  tts?: {
    audioPath: string;
    words: Word[];
    durationSec: number;
  };
  /** Resolved B-roll clip for this shot (Phase B). */
  broll?: {
    provider: BrollProvider;
    clipId: string;
    /**
     * Source URL of the clip. For downloaded/cached API clips this is the
     * remote file URL; for locally generated clips ('image' Ken Burns,
     * 'template' gradient) it is the local path; for the dependency-free
     * template fallback (no FFmpeg) it is '' — buildFrames() then falls
     * back to the template colour, so the segment still has visuals.
     */
    url: string;
    /** Local cached/generated MP4, when one exists (never re-downloaded). */
    localPath?: string;
    /** Honest duration of the clip in seconds (renderer trims/loops). */
    durationSec: number;
    /** Required attribution, e.g. "Video by X from Pexels" (when any). */
    attribution?: string;
    /**
     * Which short-clip strategy was applied to extend this clip to the
     * segment duration (only set when the source clip was shorter than
     * needed and an extension was actually generated). Absent means the
     * clip already covered the segment (or the fit failed and the honest
     * short clip was kept).
     */
    shortClipStrategy?: ShortClipStrategy;
  };
  /** Real shot duration after re-timing with TTS word timestamps (Phase B). */
  actualDurationSec?: number;
}

/**
 * The timed shot-by-shot plan for a whole video.
 * Produced by the LLM in Phase A, validated (JSON schema) by the pipeline.
 */
export interface Spec {
  /** Spec schema version. Currently 1. */
  version: 1;
  /** Working title of the video. */
  title: string;
  /** Output aspect ratio. */
  format: VideoFormat;
  /** BCP-47-ish language tag of the narration, e.g. "pt-PT". */
  language: string;
  /** Ordered shots; the video is the concatenation of these. */
  segments: Segment[];
}

/** One message in a chat-completion conversation. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * A single chat completion request to the LLM router.
 * The router walks its provider chain until one succeeds (failover).
 */
export interface ChatRequest {
  messages: ChatMessage[];
  /** Ask the provider for structured JSON output when supported. */
  jsonMode?: boolean;
  /** Cap on completion tokens. */
  maxTokens?: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

/** Result of a completed chat request, naming the provider that served it. */
export interface ChatResult {
  text: string;
  provider: string;
  model: string;
}

/**
 * Configuration for one LLM provider in the router chain.
 * Free/keyless providers come first (lower priority number = tried earlier);
 * the local Ollama backstop is always last.
 */
export interface ProviderConfig {
  /** Human/machine name, e.g. "gemini", "groq", "pollinations", "ollama". */
  name: string;
  /** OpenAI-compatible base URL, e.g. "https://api.groq.com/openai/v1". */
  baseUrl: string;
  /** Env var holding the API key, or null for keyless providers. */
  apiKeyEnv?: string | null;
  /** Models to try on this provider, in order. */
  models: string[];
  /** Lower numbers are tried first. */
  priority: number;
  /** True when the provider needs no key at all. */
  keyless?: boolean;
}

/** Top-level router configuration: the ordered provider chain. */
export interface RouterConfig {
  providers: ProviderConfig[];
}

/**
 * Result of transcribing an input audio file (faster-whisper).
 * Word timestamps drive the Phase B re-timing for audio inputs.
 */
export interface TranscriptionResult {
  text: string;
  words: Word[];
  language: string;
}

/** Result of synthesizing one segment's narration (Kokoro). */
export interface TtsResult {
  audioPath: string;
  words: Word[];
  durationSec: number;
  voice: string;
}

/**
 * The two supported pipeline entry points:
 *  - 'audio': user uploads a voice recording; we transcribe it and turn it
 *    into a Spec (repurposing content).
 *  - 'topic': user gives a topic; the LLM writes the narration from scratch.
 */
export type PipelineInput = { kind: 'audio'; audioPath: string } | { kind: 'topic'; topic: string };
