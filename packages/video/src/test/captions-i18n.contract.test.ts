/**
 * Testes de contrato da Fase 3 (c) — orçamentos de legendas por idioma.
 *
 * Verificam contra o que CORRE de verdade: `getCaptionBudget`,
 * `wrapCaptionLines` e `captionFontSizePx` de
 * `packages/video/src/captions.ts` (funções puras, determinísticas).
 *
 * Contrato:
 *  - Quatro idiomas suportados (pt-PT, pt-BR, en, fr) → orçamento
 *    próprio; pt-PT e pt-BR partilham a base "pt".
 *  - Idioma desconhecido → orçamento por omissão (inglês), nunca crash.
 *  - Lógica documentada: português/francês têm linhas mais curtas que o
 *    inglês (expansão ~15–30% nas línguas românicas).
 *
 * NOTA QA (2026-10-06): estas funções ainda NÃO estão re-exportadas no
 * `packages/video/src/index.ts` (API pública); o teste importa de
 * `../captions.js` diretamente. Recomenda-se ao dono do pacote expô-las
 * no index — ver relatório de QA.
 *
 * Correr: npm test (tsc, depois node --test sobre dist/test/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCaptionBudget,
  wrapCaptionLines,
  captionFontSizePx,
  type CaptionBudget,
} from '../captions.js';
import { getTemplate } from '../templates.js';

function budgetOf(language: string): CaptionBudget {
  return getCaptionBudget(language);
}

test('quatro idiomas da Fase 3 têm orçamento próprio', () => {
  const ptPT = budgetOf('pt-PT');
  const ptBR = budgetOf('pt-BR');
  const en = budgetOf('en');
  const fr = budgetOf('fr');
  assert.deepEqual(ptPT, { maxCharsPerLine: 28, maxLines: 2, fontScale: 0.94 });
  assert.deepEqual(ptBR, ptPT, 'pt-BR partilha a base "pt" com pt-PT');
  assert.deepEqual(en, { maxCharsPerLine: 34, maxLines: 2, fontScale: 1.0 });
  assert.deepEqual(fr, { maxCharsPerLine: 30, maxLines: 2, fontScale: 0.96 });
});

test('ordem documentada: pt < fr < en em maxCharsPerLine', () => {
  const order = ['pt-PT', 'fr', 'en'].map((l) => budgetOf(l).maxCharsPerLine);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(order[0]! < order[2]!, 'português tem linhas mais curtas que o inglês');
});

test('idioma desconhecido → orçamento por omissão (inglês), sem crash', () => {
  for (const lang of ['de', 'es', '', 'xx-YY', '  ']) {
    const b = budgetOf(lang);
    assert.deepEqual(b, budgetOf('en'), `língua "${lang}" devia cair no omissão`);
  }
});

test('tolerante a maiúsculas/espaços: "PT-pt" → pt', () => {
  assert.deepEqual(budgetOf('PT-pt'), budgetOf('pt-PT'));
  assert.deepEqual(budgetOf(' fr '), budgetOf('fr'));
});

test('wrapCaptionLines: greedy, respeita o máximo, determinístico', () => {
  const words = ['Olá', 'mundo', 'isto', 'é', 'um', 'teste'];
  const lines = wrapCaptionLines(words, 10);
  for (const line of lines) assert.ok(line.length <= 10, `linha demasiado longa: "${line}"`);
  assert.deepEqual(wrapCaptionLines(words, 10), lines, 'determinístico');
  assert.equal(lines.join(' '), words.join(' '), 'nenhuma palavra perdida ou duplicada');
});

test('wrapCaptionLines: palavra maior que o máximo fica sozinha (nunca parte)', () => {
  const lines = wrapCaptionLines(['abc', 'supercalifragilistic', 'de'], 10);
  assert.deepEqual(lines, ['abc', 'supercalifragilistic', 'de']);
});

test('wrapCaptionLines: palavras vazias são ignoradas; lista vazia → []', () => {
  assert.deepEqual(wrapCaptionLines(['a', '  ', '', 'b'], 10), ['a b']);
  assert.deepEqual(wrapCaptionLines([], 10), []);
});

test('captionFontSizePx: escala do template pelo fontScale do idioma', () => {
  const template = getTemplate('bold-social');
  const base = template.caption.fontSizePx;
  assert.equal(captionFontSizePx(template, 'en'), base, 'inglês: escala 1.0');
  assert.ok(captionFontSizePx(template, 'pt-PT') < base, 'português: fonte ligeiramente menor');
  assert.ok(
    captionFontSizePx(template, 'pt-PT') < captionFontSizePx(template, 'fr'),
    'pt (0.94) < fr (0.96)',
  );
  assert.ok(captionFontSizePx(template, 'de') === base, 'desconhecido → omissão inglês');
});
