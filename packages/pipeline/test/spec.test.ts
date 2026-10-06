/**
 * Tests for spec.ts — Phase A generation + strict validation.
 * The LLM router is a MOCK with the same shape ({ chatJson }); no network.
 * Run: npm test (tsc → node --test dist/test)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateSpec, validateSpecJson, SPEC_SYSTEM_PROMPT, buildSpecSystemPrompt } from '../src/spec.js';
import type { ChatRequest, PipelineInput } from '@shorts-forge/shared';

function mockRouter(data: unknown, capture: { req?: ChatRequest } = {}) {
  return {
    chatJson: async (req: ChatRequest): Promise<{ data: unknown }> => {
      capture.req = req;
      return { data };
    },
  };
}

interface RawSegment extends Record<string, unknown> {}

function validRawSpec(): { title: string; segments: RawSegment[] } {
  return {
    title: 'Título de teste',
    segments: [
      {
        id: 'seg-01',
        narration: 'Primeira narração em português europeu.',
        visualKeywords: ['sunrise'],
        brollDescription: 'Nascer do sol sobre a cidade',
        targetDurationSec: 4.0,
        hookScore: 0.9,
        hookLine: 'Olha isto',
      },
      {
        id: 'seg-02',
        narration: 'Segunda narração, sem hook.',
        visualKeywords: ['city', 'night'],
        brollDescription: 'Cidade à noite',
        targetDurationSec: 5.0,
      },
    ],
  };
}

const topicInput: PipelineInput = { kind: 'topic', topic: 'hábitos matinais' };

describe('generateSpec', () => {
  it('returns a valid Spec (version 1) with default format/language', async () => {
    const spec = await generateSpec(topicInput, mockRouter(validRawSpec()));
    assert.equal(spec.version, 1);
    assert.equal(spec.title, 'Título de teste');
    assert.equal(spec.format, '9:16');
    assert.equal(spec.language, 'pt-PT');
    assert.equal(spec.segments.length, 2);
    assert.equal(spec.segments[0]?.hookScore, 0.9);
    assert.equal(spec.segments[1]?.hookLine, undefined);
  });

  it('respects format/language options', async () => {
    const spec = await generateSpec(
      topicInput,
      mockRouter(validRawSpec()),
      { format: '16:9', language: 'pt-PT' },
    );
    assert.equal(spec.format, '16:9');
  });

  it('system prompt demands pt-PT narration and ENGLISH visualKeywords', () => {
    assert.match(SPEC_SYSTEM_PROMPT, /EUROPEAN Portuguese/);
    assert.match(SPEC_SYSTEM_PROMPT, /visualKeywords.*ENGLISH|ENGLISH.*visualKeywords/s);
    assert.match(SPEC_SYSTEM_PROMPT, /Pexels/);
  });

  it('topic input: user prompt contains the topic', async () => {
    const capture: { req?: ChatRequest } = {};
    await generateSpec(topicInput, mockRouter(validRawSpec(), capture));
    const userMsg = capture.req?.messages.find((m) => m.role === 'user')?.content ?? '';
    assert.match(userMsg, /hábitos matinais/);
    assert.equal(capture.req?.jsonMode, true);
  });

  it('audio input with transcript: user prompt includes transcript timings', async () => {
    const capture: { req?: ChatRequest } = {};
    const input: PipelineInput = { kind: 'audio', audioPath: '/tmp/voz.wav' };
    await generateSpec(
      input,
      mockRouter(validRawSpec(), capture),
      {
        transcript: {
          text: 'Olá, bom dia a todos.',
          words: [
            { word: 'Olá,', start: 0.0, end: 0.4 },
            { word: 'bom', start: 0.5, end: 0.7 },
          ],
          language: 'pt-PT',
        },
      },
    );
    const userMsg = capture.req?.messages.find((m) => m.role === 'user')?.content ?? '';
    assert.match(userMsg, /Olá,/);
    assert.match(userMsg, /REAL word timings/);
  });

  it('accepts a JSON string (even fenced) from the model', async () => {
    const fenced = '```json\n' + JSON.stringify(validRawSpec()) + '\n```';
    const spec = await generateSpec(topicInput, mockRouter(fenced));
    assert.equal(spec.segments.length, 2);
  });

  it('wraps router failures in a descriptive error', async () => {
    const failing = { chatJson: async () => { throw new Error('boom 429'); } };
    await assert.rejects(
      () => generateSpec(topicInput, failing),
      /falha ao gerar a Spec via LLM: boom 429/,
    );
  });

  it('enforces the ±20% total-duration rule when a target is given', async () => {
    const raw = validRawSpec(); // total 9.0s
    await assert.rejects(
      () => generateSpec(topicInput, mockRouter(raw), { targetDurationSec: 60 }),
      /desvia-se mais de 20%/,
    );
    // Within tolerance: passes.
    const spec = await generateSpec(topicInput, mockRouter(raw), { targetDurationSec: 10 });
    assert.equal(spec.segments.length, 2);
  });
});

describe('validateSpecJson', () => {
  it('rejects empty segments', () => {
    assert.throws(
      () => validateSpecJson({ title: 'x', segments: [] }),
      (err: unknown) => err instanceof Error && /"segments"/.test(err.message),
    );
  });

  it('rejects missing narration, naming the field', () => {
    const raw = validRawSpec();
    delete raw.segments[0]?.['narration'];
    assert.throws(
      () => validateSpecJson(raw),
      /"segments\[0\]\.narration"/,
    );
  });

  it('rejects duplicate ids, naming the field', () => {
    const raw = validRawSpec();
    raw.segments[1] = { ...raw.segments[1], id: 'seg-01' };
    assert.throws(() => validateSpecJson(raw), /duplicado/);
  });

  it('rejects non-positive targetDurationSec, naming the field', () => {
    for (const bad of [0, -3, Number.NaN, 'cinco']) {
      const raw = validRawSpec();
      raw.segments[0]!['targetDurationSec'] = bad;
      assert.throws(
        () => validateSpecJson(raw),
        /"segments\[0\]\.targetDurationSec"/,
        `should reject ${String(bad)}`,
      );
    }
  });

  it('rejects visualKeywords with 0 or 5+ items, naming the field', () => {
    for (const kw of [[], ['a', 'b', 'c', 'd', 'e']]) {
      const raw = validRawSpec();
      raw.segments[0]!['visualKeywords'] = kw;
      assert.throws(
        () => validateSpecJson(raw),
        /"segments\[0\]\.visualKeywords"/,
        `should reject ${kw.length} keywords`,
      );
    }
  });

  it('rejects a non-object root', () => {
    assert.throws(() => validateSpecJson([1, 2, 3]), /"\(raiz\)"/);
  });

  it('rejects out-of-range hookScore', () => {
    const raw = validRawSpec();
    raw.segments[0]!['hookScore'] = 1.5;
    assert.throws(() => validateSpecJson(raw), /hookScore/);
  });
});

describe('buildSpecSystemPrompt (i18n)', () => {
  it('pt-PT keeps the EUROPEAN Portuguese guardrails', () => {
    const p = buildSpecSystemPrompt('pt-PT');
    assert.match(p, /EUROPEAN Portuguese/);
    assert.match(p, /telemóvel/);
    assert.match(p, /estou a fazer/);
  });

  it('pt-BR demands Brazilian Portuguese (and forbids pt-PT forms)', () => {
    const p = buildSpecSystemPrompt('pt-BR');
    assert.match(p, /BRAZILIAN Portuguese/);
    assert.match(p, /celular/);
    assert.match(p, /estou fazendo/);
    assert.doesNotMatch(p, /EUROPEAN Portuguese/);
  });

  it('en demands natural spoken American English', () => {
    const p = buildSpecSystemPrompt('en');
    assert.match(p, /American English/);
    assert.doesNotMatch(p, /EUROPEAN Portuguese/);
  });

  it('fr demands natural spoken French (France)', () => {
    const p = buildSpecSystemPrompt('fr');
    assert.match(p, /French \(France\)/);
    assert.match(p, /"tu" forms/);
  });

  it('visualKeywords stay ENGLISH in every language', () => {
    for (const lang of ['pt-PT', 'pt-BR', 'en', 'fr']) {
      const p = buildSpecSystemPrompt(lang);
      assert.match(p, /visualKeywords MUST be in ENGLISH/, `lang=${lang}`);
      assert.match(p, /Pexels/, `lang=${lang}`);
    }
  });

  it('unknown languages get a generic rule naming the tag', () => {
    const p = buildSpecSystemPrompt('de');
    assert.match(p, /"de"/);
    assert.match(p, /visualKeywords MUST be in ENGLISH/);
  });

  it('SPEC_SYSTEM_PROMPT is the pt-PT specialization (backwards compat)', () => {
    assert.equal(SPEC_SYSTEM_PROMPT, buildSpecSystemPrompt('pt-PT'));
  });
});

describe('generateSpec language wiring (mocked LLM)', () => {
  it('sends the French system prompt and returns spec.language "fr"', async () => {
    const capture: { req?: ChatRequest } = {};
    const spec = await generateSpec(
      topicInput,
      mockRouter(validRawSpec(), capture),
      { language: 'fr' },
    );
    assert.equal(spec.language, 'fr');
    const systemMsg = capture.req?.messages.find((m) => m.role === 'system')?.content ?? '';
    assert.match(systemMsg, /French \(France\)/);
    const userMsg = capture.req?.messages.find((m) => m.role === 'user')?.content ?? '';
    assert.match(userMsg, /Narration language: fr/);
  });

  it('sends the pt-BR system prompt for Brazilian jobs', async () => {
    const capture: { req?: ChatRequest } = {};
    const spec = await generateSpec(
      topicInput,
      mockRouter(validRawSpec(), capture),
      { language: 'pt-BR' },
    );
    assert.equal(spec.language, 'pt-BR');
    const systemMsg = capture.req?.messages.find((m) => m.role === 'system')?.content ?? '';
    assert.match(systemMsg, /BRAZILIAN Portuguese/);
  });
});
