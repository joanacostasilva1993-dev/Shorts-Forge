/**
 * Fase A — geração da Spec (guião plano-a-plano) através do LLM.
 *
 * O router de LLMs é injetado (qualquer objeto com `chatJson(req)`), o que
 * mantém este módulo testável sem dependências de rede. O prompt pede JSON
 * estrito; a validação abaixo garante o contrato `Spec` do shared antes de
 * a Spec chegar à UI para revisão.
 *
 * Decisão de prompt (documentada): a narração é pedida NO IDIOMA DO JOB
 * (ver `buildSpecSystemPrompt`) mas as `visualKeywords` são pedidas em
 * INGLÊS — as APIs de stock footage (Pexels, Pixabay) indexam muito melhor
 * em inglês, seja qual for o idioma da narração.
 */

import type {
  ChatRequest,
  PipelineInput,
  Spec,
  TranscriptionResult,
  VideoFormat,
} from '@shorts-forge/shared';

/** Minimal router surface used here: any object with chatJson works. */
export interface SpecRouterLike {
  chatJson(req: ChatRequest): Promise<{ data: unknown }>;
}

export interface GenerateSpecOptions {
  /** Output aspect; default '9:16'. */
  format?: VideoFormat;
  /** Narration language tag; default 'pt-PT'. */
  language?: string;
  /**
   * Transcript of an audio input (kind 'audio'). When present, the model is
   * told to derive the narration from this transcript (with its real
   * timings). When absent, it writes original narration for the topic/audio.
   */
  transcript?: TranscriptionResult;
  /** Approximate total video length (seconds); segments are sized to fit. */
  targetDurationSec?: number;
  /** Hard cap on the number of segments; default 12. */
  maxSegments?: number;
}

const DEFAULT_FORMAT: VideoFormat = '9:16';
const DEFAULT_LANGUAGE = 'pt-PT';
const DEFAULT_MAX_SEGMENTS = 12;

/**
 * Per-language narration rules injected into the system prompt (rule 1),
 * plus the spoken-word budget per segment (rule 5). English prompt
 * engineering throughout; the *output* language is what varies.
 *
 * Languages not listed here get a generic rule naming the tag — the LLM
 * still writes in the requested language, just without the
 * dialect-specific guardrails.
 */
const PROMPT_LANGUAGE_RULES: Record<string, { rule: string; wordsPerSegment: string }> = {
  'pt-PT': {
    rule: 'narration MUST be written in EUROPEAN Portuguese (pt-PT), never Brazilian Portuguese. Use "telemóvel" not "celular", "ecrã" not "tela", "fixe" not "legal", second-person "tu" verb forms ("tu consegues", "o teu"), and the European gerund construction ("estou a fazer", NEVER "estou fazendo"). The narration is what the viewer hears, so it must sound natural when spoken aloud in Portugal.',
    wordsPerSegment: '8-22 spoken words each in pt-PT',
  },
  'pt-BR': {
    rule: 'narration MUST be written in BRAZILIAN Portuguese (pt-BR), never European Portuguese. Use "celular" not "telemóvel", "tela" not "ecrã", "legal" not "fixe", "você" forms ("você consegue", "o seu"), and the Brazilian gerund construction ("estou fazendo", NEVER "estou a fazer"). The narration is what the viewer hears, so it must sound natural when spoken aloud in Brazil.',
    wordsPerSegment: '8-22 spoken words each in pt-BR',
  },
  en: {
    rule: 'narration MUST be written in natural spoken American English. Prefer contractions ("you\'ll", "it\'s"), short punchy sentences, and conversational phrasing a native speaker would actually say out loud — never stiff written-style prose.',
    wordsPerSegment: '10-26 spoken words each in English',
  },
  fr: {
    rule: 'narration MUST be written in natural spoken French (France). Use "tu" forms ("tu peux", "ton"), short sentences that read well aloud, and everyday vocabulary — never literal translations from English or stiff written-style prose.',
    wordsPerSegment: '8-20 spoken words each in French',
  },
};

function languageRule(language: string): { rule: string; wordsPerSegment: string } {
  const known = PROMPT_LANGUAGE_RULES[language];
  if (known) return known;
  return {
    rule: `narration MUST be written in the language tagged "${language}". Write naturally, as a native speaker would say it out loud — short sentences, conversational phrasing, never stiff written-style prose or literal translations from another language.`,
    wordsPerSegment: '8-22 spoken words each',
  };
}

/**
 * Builds the system prompt for a narration language.
 *
 * English prompt-engineering; the *output* rules force narration in
 * `language` and ENGLISH visualKeywords (stock APIs index better in
 * English regardless of narration language).
 */
export function buildSpecSystemPrompt(language: string): string {
  const lang = languageRule(language);
  return `You are an expert scriptwriter for short-form video content (vertical 9:16 shorts and horizontal 16:9 videos).

You ALWAYS reply with a single JSON object and nothing else — no markdown fences, no commentary. The JSON must match this exact shape:

{
  "title": "short catchy video title",
  "segments": [
    {
      "id": "seg-01",
      "narration": "the exact words the voice will speak in this shot",
      "visualKeywords": ["english", "keywords", "for", "stock"],
      "brollDescription": "plain-language description of the desired B-roll shot",
      "targetDurationSec": 5.0,
      "hookScore": 0.9,
      "hookLine": "on-screen hook text"
    }
  ]
}

Rules:
1. ${lang.rule}
2. visualKeywords MUST be in ENGLISH (1 to 4 items). Stock footage APIs (Pexels, Pixabay) index far better in English. Pick concrete visual nouns/adjectives a camera could capture, e.g. ["sunrise", "city", "timelapse"] — not abstract concepts.
3. brollDescription describes the B-roll shot in plain language (${language} is fine here).
4. Segment ids MUST be unique and ordered: "seg-01", "seg-02", ...
5. targetDurationSec is a positive number (seconds) estimating how long the narration takes to speak. Keep segments between 3 and 8 seconds (roughly ${lang.wordsPerSegment}).
6. The FIRST segment is the HOOK: open with a bold claim, a surprising fact or a direct question. Give it hookScore >= 0.8 and a hookLine of at most 6 words (in ${language}) for on-screen text.
7. hookScore is a number from 0 to 1; hookLine is optional on non-hook segments.
8. Respect any topic, transcript, format, duration target and segment limits given in the user message.`;
}

/**
 * System prompt (English prompt-engineering; the *output* rules force
 * pt-PT narration and ENGLISH visualKeywords). Kept as the pt-PT
 * specialization of buildSpecSystemPrompt for backwards compatibility.
 */
export const SPEC_SYSTEM_PROMPT = buildSpecSystemPrompt('pt-PT');

function buildUserPrompt(input: PipelineInput, opts: Required<Pick<GenerateSpecOptions, 'format' | 'language'>> & GenerateSpecOptions): string {
  const maxSegments = opts.maxSegments ?? DEFAULT_MAX_SEGMENTS;
  const head = [
    `Write a video script as JSON. Format: ${opts.format}. Narration language: ${opts.language}.`,
    `Use at most ${maxSegments} segments.`,
  ];
  if (opts.targetDurationSec !== undefined) {
    head.push(`Aim for a total video length of about ${opts.targetDurationSec} seconds (sum of targetDurationSec).`);
  }

  if (input.kind === 'topic') {
    return [...head, `Topic: ${input.topic}`, 'Write an original, engaging script about this topic.'].join('\n');
  }

  // kind === 'audio'
  if (opts.transcript) {
    const t = opts.transcript;
    const timingTable = chunkWords(t);
    return [
      ...head,
      `This video repurposes an existing audio recording. Derive the narration from the transcript below — keep its meaning and order, but you may tighten the wording for short-form pacing.`,
      `Transcript language: ${t.language}. Total duration: ${timingTable.totalSec.toFixed(1)}s.`,
      `IMPORTANT: align each segment's targetDurationSec with the REAL word timings (start-end in seconds) so the plan matches the recorded audio. Do not invent content the speaker did not say.`,
      'Transcript with word timings:',
      timingTable.lines.join('\n'),
    ].join('\n');
  }

  return [
    ...head,
    `The video repurposes an audio recording (no transcript was provided), so write an original narration suitable for the recording's topic.`,
    `Audio file: ${input.audioPath}`,
  ].join('\n');
}

/** Compact "word[start-end]" timing table, wrapped into lines. */
function chunkWords(t: TranscriptionResult): { lines: string[]; totalSec: number } {
  const lines: string[] = [];
  let current = '';
  let totalSec = 0;
  for (const w of t.words) {
    if (Number.isFinite(w.end)) totalSec = Math.max(totalSec, w.end);
    const token = `${w.word}[${w.start.toFixed(1)}-${w.end.toFixed(1)}]`;
    if ((current + ' ' + token).length > 110) {
      lines.push(current.trim());
      current = token;
    } else {
      current = current ? `${current} ${token}` : token;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return { lines, totalSec };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The model sometimes returns a JSON string (or a fenced block); normalize it. */
function coerceJson(data: unknown): unknown {
  if (typeof data === 'string') {
    const trimmed = data.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    return JSON.parse(trimmed) as unknown;
  }
  return data;
}

/** Field-scoped validation error; messages are in pt-PT (they surface in the UI). */
function fail(field: string, reason: string): never {
  throw new Error(`Spec inválida — campo "${field}": ${reason}`);
}

function reqString(obj: Record<string, unknown>, field: string, path: string): string {
  const v = obj[field];
  if (typeof v !== 'string' || v.trim().length === 0) fail(path, 'tem de ser uma string não vazia');
  return (v as string).trim();
}

function optNumber01(v: unknown, path: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    fail(path, 'tem de ser um número entre 0 e 1');
  }
  return v as number;
}

/**
 * Strictly validates the LLM's raw JSON and converts it into a canonical
 * `Spec`. Throws a descriptive Error naming the offending field.
 */
export function validateSpecJson(
  raw: unknown,
  opts: { format?: VideoFormat; language?: string; targetDurationSec?: number | undefined } = {},
): Spec {
  const data = coerceJson(raw);
  if (!isRecord(data)) fail('(raiz)', 'a resposta do LLM tem de ser um objeto JSON');

  const format: VideoFormat = opts.format ?? DEFAULT_FORMAT;
  const language = (opts.language ?? DEFAULT_LANGUAGE).trim() || DEFAULT_LANGUAGE;

  const title = reqString(data, 'title', 'title');

  const segmentsRaw = data['segments'];
  if (!Array.isArray(segmentsRaw) || segmentsRaw.length === 0) {
    fail('segments', 'tem de ser um array não vazio');
  }

  const seenIds = new Set<string>();
  const segments = segmentsRaw.map((s, i) => {
    const path = `segments[${i}]`;
    if (!isRecord(s)) fail(path, 'tem de ser um objeto');

    const id = reqString(s, 'id', `${path}.id`);
    if (seenIds.has(id)) fail(`${path}.id`, `id duplicado: "${id}"`);
    seenIds.add(id);

    const narration = reqString(s, 'narration', `${path}.narration`);

    const kw = s['visualKeywords'];
    if (!Array.isArray(kw) || kw.length < 1 || kw.length > 4) {
      fail(`${path}.visualKeywords`, 'tem de ser um array com 1 a 4 palavras-chave');
    }
    const visualKeywords = kw.map((k, j) => {
      if (typeof k !== 'string' || k.trim().length === 0) {
        fail(`${path}.visualKeywords[${j}]`, 'cada palavra-chave tem de ser uma string não vazia');
      }
      return (k as string).trim();
    });

    const brollDescription = reqString(s, 'brollDescription', `${path}.brollDescription`);

    const dur = s['targetDurationSec'];
    if (typeof dur !== 'number' || !Number.isFinite(dur) || dur <= 0) {
      fail(`${path}.targetDurationSec`, 'tem de ser um número positivo (segundos)');
    }

    const seg: Spec['segments'][number] = {
      id,
      narration,
      visualKeywords,
      brollDescription,
      targetDurationSec: dur,
    };
    const hookScore = optNumber01(s['hookScore'], `${path}.hookScore`);
    if (hookScore !== undefined) seg.hookScore = hookScore;
    const hookLine = s['hookLine'];
    if (hookLine !== undefined) {
      if (typeof hookLine !== 'string' || hookLine.trim().length === 0) {
        fail(`${path}.hookLine`, 'se presente, tem de ser uma string não vazia');
      }
      seg.hookLine = hookLine.trim();
    }
    return seg;
  });

  if (opts.targetDurationSec !== undefined && opts.targetDurationSec > 0) {
    const total = segments.reduce((acc, s) => acc + s.targetDurationSec, 0);
    const drift = Math.abs(total - opts.targetDurationSec) / opts.targetDurationSec;
    if (drift > 0.2) {
      fail(
        'segments',
        `a soma das durações (${total.toFixed(1)}s) desvia-se mais de 20% do alvo pedido (${opts.targetDurationSec}s)`,
      );
    }
  }

  const version = data['version'];
  if (version !== undefined && version !== 1) fail('version', 'tem de ser 1');

  return { version: 1, title, format, language, segments };
}

/**
 * Phase A: asks the LLM (via the injected router) for the video Spec and
 * validates it strictly before returning.
 */
export async function generateSpec(
  input: PipelineInput,
  router: SpecRouterLike,
  opts: GenerateSpecOptions = {},
): Promise<Spec> {
  const format = opts.format ?? DEFAULT_FORMAT;
  const language = (opts.language ?? DEFAULT_LANGUAGE).trim() || DEFAULT_LANGUAGE;

  const request: ChatRequest = {
    messages: [
      { role: 'system', content: buildSpecSystemPrompt(language) },
      { role: 'user', content: buildUserPrompt(input, { ...opts, format, language }) },
    ],
    jsonMode: true,
    maxTokens: 4000,
  };

  let result: { data: unknown };
  try {
    result = await router.chatJson(request);
  } catch (err) {
    throw new Error(`falha ao gerar a Spec via LLM: ${err instanceof Error ? err.message : String(err)}`);
  }

  return validateSpecJson(result.data, { format, language, targetDurationSec: opts.targetDurationSec });
}
