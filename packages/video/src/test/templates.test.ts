import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTemplate, listTemplateIds } from '../index.js';

test('three templates exist with pt-PT names', () => {
  assert.deepEqual(listTemplateIds().sort(), ['bold-social', 'cinematic', 'minimal']);
  assert.equal(getTemplate('bold-social').name, 'Social Intenso');
  assert.equal(getTemplate('minimal').name, 'Minimalista');
  assert.equal(getTemplate('cinematic').name, 'Cinematográfico');
});

test('templates carry colors, font stack and caption geometry', () => {
  for (const id of listTemplateIds()) {
    const t = getTemplate(id);
    assert.ok(t.description.length > 10, `${id} description`);
    for (const k of ['bg', 'fg', 'accent', 'highlight'] as const) {
      assert.match(t.colors[k], /^#[0-9a-f]{6}$/i, `${id} colors.${k}`);
    }
    assert.ok(t.fontStack.length > 0);
    assert.ok(t.caption.fontSizePx > 0);
    assert.ok(['center', 'lower-third'].includes(t.caption.position));
  }
  assert.equal(getTemplate('bold-social').caption.strokePx, 3);
  assert.equal(getTemplate('minimal').caption.strokePx, 0);
  assert.equal(getTemplate('bold-social').caption.position, 'center');
  assert.equal(getTemplate('minimal').caption.position, 'lower-third');
  assert.equal(getTemplate('cinematic').caption.position, 'lower-third');
});

test('getTemplate throws on unknown id', () => {
  assert.throws(() => getTemplate('nope'), /Modelo desconhecido/);
  assert.throws(() => getTemplate(''), /Modelo desconhecido/);
});
