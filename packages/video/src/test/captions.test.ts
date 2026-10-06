import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCues,
  activeCue,
  escapeHtml,
  renderCaptionHtml,
  renderCaptionHtmlWithActive,
  parseCueTimings,
  getCaptionBudget,
  wrapCaptionLines,
  captionFontSizePx,
} from '../index.js';
import { getTemplate } from '../index.js';

const template = getTemplate('bold-social');

const words = [
  { word: 'Olá', start: 0.0, end: 0.4 },
  { word: 'mundo', start: 0.4, end: 0.9 },
  { word: 'cruel', start: 1.2, end: 1.7 },
];

test('buildCues drops zero-duration and invalid words, keeps order', () => {
  const cues = buildCues([
    ...words,
    { word: 'nada', start: 2.0, end: 2.0 },
    { word: 'inv', start: 3.0, end: 2.5 },
    { word: 'nan', start: NaN, end: 4.0 },
  ]);
  assert.deepEqual(
    cues.map((c) => c.word),
    ['Olá', 'mundo', 'cruel'],
  );
});

test('activeCue: exact boundaries (start inclusive, end exclusive)', () => {
  const cues = buildCues(words);
  assert.equal(activeCue(cues, 0.0), 0); // exact start of first
  assert.equal(activeCue(cues, 0.4), 1); // end of first == start of second → second
  assert.equal(activeCue(cues, 0.899), 1);
  assert.equal(activeCue(cues, 1.0), -1); // gap between words
  assert.equal(activeCue(cues, 1.2), 2);
  assert.equal(activeCue(cues, 1.7), -1); // exact end of last
});

test('activeCue: before first and after last → -1', () => {
  const cues = buildCues(words);
  assert.equal(activeCue(cues, -0.5), -1);
  assert.equal(activeCue(cues, 99), -1);
  assert.equal(activeCue([], 0.5), -1);
});

test('renderCaptionHtml assigns active/upcoming classes deterministically', () => {
  const cues = buildCues(words);
  const html = renderCaptionHtml(cues, 0.5, template);
  assert.match(html, /<span class="w active" data-start="0.4" data-duration="0.5">mundo<\/span>/);
  assert.match(html, /<span class="w" data-start="0" data-duration="0.4">Olá<\/span>/);
  assert.match(html, /<span class="w upcoming" data-start="1.2" data-duration="0.5">cruel<\/span>/);
  // deterministic: same input → same string
  assert.equal(html, renderCaptionHtml(cues, 0.5, template));
});

test('renderCaptionHtml: t before first → all upcoming, t after last → none active', () => {
  const cues = buildCues(words);
  const before = renderCaptionHtml(cues, -1, template);
  assert.ok(!before.includes('active'));
  assert.equal((before.match(/w upcoming/g) ?? []).length, 3);
  const after = renderCaptionHtml(cues, 10, template);
  assert.ok(!after.includes('active'));
  assert.ok(!after.includes('upcoming'));
});

test('renderCaptionHtml escapes HTML in words', () => {
  const cues = buildCues([{ word: '<b>&"\'', start: 0, end: 1 }]);
  const html = renderCaptionHtml(cues, 0.5, template);
  assert.ok(html.includes('&lt;b&gt;&amp;&quot;&#39;'));
  assert.ok(!html.includes('<b>'));
});

test('renderCaptionHtmlWithActive highlights by index', () => {
  const cues = buildCues(words);
  const html = renderCaptionHtmlWithActive(cues, 2, template);
  assert.match(html, /<span class="w active"[^>]*>cruel<\/span>/);
  assert.equal((html.match(/w active/g) ?? []).length, 1);
});

test('escapeHtml handles all special chars', () => {
  assert.equal(escapeHtml(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&#39;f');
});

test('parseCueTimings recovers timings from caption HTML', () => {
  const cues = buildCues(words);
  const html = renderCaptionHtml(cues, 0.5, template);
  assert.deepEqual(parseCueTimings(html), [
    { start: 0, end: 0.4 },
    { start: 0.4, end: 0.9 },
    { start: 1.2, end: 1.7 },
  ]);
});

test('getCaptionBudget: per-language budgets (pt shorter lines than en)', () => {
  const pt = getCaptionBudget('pt-PT');
  const ptBr = getCaptionBudget('pt-BR');
  const en = getCaptionBudget('en');
  const fr = getCaptionBudget('fr');
  assert.equal(pt.maxCharsPerLine, 28);
  assert.equal(ptBr.maxCharsPerLine, 28);
  assert.equal(en.maxCharsPerLine, 34);
  assert.equal(fr.maxCharsPerLine, 30);
  assert.ok(pt.maxCharsPerLine < en.maxCharsPerLine, 'português: linhas mais curtas que inglês');
  assert.ok(pt.fontScale < 1, 'português: fonte ligeiramente menor');
  assert.equal(en.fontScale, 1.0);
});

test('getCaptionBudget: unknown language falls back to English', () => {
  assert.deepEqual(getCaptionBudget('de'), getCaptionBudget('en'));
  assert.deepEqual(getCaptionBudget(''), getCaptionBudget('en'));
});

test('wrapCaptionLines: greedy wrap respecting maxCharsPerLine', () => {
  const lines = wrapCaptionLines(['Olá', 'mundo', 'cruel', 'e', 'maravilhoso'], 10);
  assert.deepEqual(lines, ['Olá mundo', 'cruel e', 'maravilhoso']);
  for (const line of lines.slice(0, -1)) {
    assert.ok(line.length <= 10);
  }
});

test('wrapCaptionLines: over-long single word gets its own line', () => {
  const lines = wrapCaptionLines(['anticonstitucionalissimamente'], 10);
  assert.deepEqual(lines, ['anticonstitucionalissimamente']);
});

test('wrapCaptionLines: empty input → no lines', () => {
  assert.deepEqual(wrapCaptionLines([], 28), []);
});

test('captionFontSizePx: applies the language budget over the template size', () => {
  const t = getTemplate('bold-social'); // caption.fontSizePx = 68
  assert.equal(captionFontSizePx(t, 'en'), 68);
  assert.equal(captionFontSizePx(t, 'pt-PT'), Math.round(68 * 0.94));
  assert.equal(captionFontSizePx(t, 'fr'), Math.round(68 * 0.96));
  assert.equal(captionFontSizePx(t, 'xx'), 68, 'idioma desconhecido → orçamento inglês');
});
