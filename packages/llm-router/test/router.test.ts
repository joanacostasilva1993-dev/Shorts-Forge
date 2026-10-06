// Smoke tests do llm-router — 100% offline, sem chaves reais.
// Levanta servidores HTTP locais que simulam fornecedores OpenAI-compatíveis.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRouter, loadConfigFromEnv } from '../src/index.js';
import type { ProviderConfig } from '../src/index.js';

interface Hit {
  server: string;
  url: string;
  body: any;
  authorization: string | undefined;
}

interface MockBehavior {
  status: number;
  json?: unknown;
  raw?: string;
  delayMs?: number;
}

function chatCompletion(content: string): unknown {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 1720000000,
    model: 'mock-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
  };
}

async function startMock(
  name: string,
  behavior: MockBehavior,
  order: string[],
): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body: any = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      hits.push({
        server: name,
        url: req.url ?? '',
        body,
        authorization: req.headers.authorization,
      });
      order.push(name);
      const respond = () => {
        if (req.socket.destroyed) return;
        if (behavior.raw !== undefined) {
          res.writeHead(behavior.status, { 'Content-Type': 'text/plain' });
          res.end(behavior.raw);
        } else {
          res.writeHead(behavior.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(behavior.json ?? {}));
        }
      };
      if (behavior.delayMs) {
        const t = setTimeout(respond, behavior.delayMs);
        t.unref?.();
      } else {
        respond();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function keylessProvider(name: string, baseUrl: string, priority: number): ProviderConfig {
  return {
    name,
    baseUrl,
    apiKeyEnv: null,
    models: [`${name}-model`],
    priority,
    keyless: true,
  };
}

const MESSAGES = [{ role: 'user', content: 'Olá' }] as const;

test('failover: 429 -> 500 -> sucesso, tentativas registadas por ordem e sem repetições', async () => {
  const order: string[] = [];
  const a = await startMock('a', { status: 429, json: { error: 'rate limited' } }, order);
  const b = await startMock('b', { status: 500, json: { error: 'boom' } }, order);
  const c = await startMock('c', { status: 200, json: chatCompletion('olá do C') }, order);
  try {
    const router = createRouter({
      providers: [
        keylessProvider('a', a.url, 1),
        keylessProvider('b', b.url, 2),
        keylessProvider('c', c.url, 3),
      ],
    });

    const res = await router.chat({
      messages: [...MESSAGES],
      maxTokens: 50,
    });

    assert.equal(res.text, 'olá do C');
    assert.equal(res.provider, 'c');
    assert.equal(res.model, 'c-model');

    // Ordem das tentativas e exatamente uma tentativa por fornecedor.
    assert.deepEqual(order, ['a', 'b', 'c']);
    assert.equal(a.hits.length, 1);
    assert.equal(b.hits.length, 1);
    assert.equal(c.hits.length, 1);

    // Corpo do pedido OpenAI-compatible.
    const body = c.hits[0].body;
    assert.equal(c.hits[0].url, '/chat/completions');
    assert.equal(body.model, 'c-model');
    assert.equal(body.max_tokens, 50);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'Olá' }]);
    assert.ok(!('response_format' in body), 'chat() sem jsonMode não deve pedir json_object');
  } finally {
    await a.close();
    await b.close();
    await c.close();
  }
});

test('chatJson: faz parse de JSON válido e envia response_format json_object', async () => {
  const order: string[] = [];
  const srv = await startMock('j', { status: 200, json: chatCompletion('{"titulo":"Short","cenas":3}') }, order);
  try {
    const router = createRouter({ providers: [keylessProvider('j', srv.url, 1)] });
    const res = await router.chatJson<{ titulo: string; cenas: number }>({
      messages: [...MESSAGES],
    });
    assert.deepEqual(res.data, { titulo: 'Short', cenas: 3 });
    assert.equal(res.provider, 'j');
    assert.equal(res.model, 'j-model');
    assert.deepEqual(srv.hits[0].body.response_format, { type: 'json_object' });
  } finally {
    await srv.close();
  }
});

test('chatJson: lança erro com o nome do fornecedor e excerto perante JSON inválido', async () => {
  const order: string[] = [];
  const srv = await startMock('mau', { status: 200, json: chatCompletion('isto não é JSON {{{') }, order);
  try {
    const router = createRouter({ providers: [keylessProvider('mau', srv.url, 1)] });
    await assert.rejects(
      () => router.chatJson({ messages: [...MESSAGES] }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /mau/);
        assert.match(err.message, /invalid JSON/);
        assert.match(err.message, /isto não é JSON/);
        return true;
      },
    );
  } finally {
    await srv.close();
  }
});

test('fornecedor sem chave obrigatória é ignorado silenciosamente', async () => {
  const order: string[] = [];
  delete process.env.LLM_ROUTER_TEST_MISSING_KEY;
  const c = await startMock('c', { status: 200, json: chatCompletion('do C') }, order);
  const unreachable: ProviderConfig = {
    name: 'semchave',
    baseUrl: 'http://127.0.0.1:1/', // nunca deve ser contactado
    apiKeyEnv: 'LLM_ROUTER_TEST_MISSING_KEY',
    models: ['x'],
    priority: 1,
  };
  try {
    const router = createRouter({
      providers: [unreachable, keylessProvider('c', c.url, 2)],
    });
    const res = await router.chat({ messages: [...MESSAGES] });
    assert.equal(res.provider, 'c');
    assert.equal(res.text, 'do C');
    assert.deepEqual(order, ['c'], 'o fornecedor sem chave não deve ser tentado');
  } finally {
    await c.close();
  }
});

test('envia o cabeçalho Authorization com a chave; omite-o em fornecedores keyless', async () => {
  const order: string[] = [];
  process.env.LLM_ROUTER_TEST_KEY = 'sk-test-123';
  const keyed = await startMock('keyed', { status: 200, json: chatCompletion('com chave') }, order);
  const free = await startMock('free', { status: 200, json: chatCompletion('sem chave') }, order);
  try {
    const router = createRouter({
      providers: [
        {
          name: 'keyed',
          baseUrl: keyed.url,
          apiKeyEnv: 'LLM_ROUTER_TEST_KEY',
          models: ['keyed-model'],
          priority: 1,
        },
        keylessProvider('free', free.url, 2),
      ],
    });
    await router.chat({ messages: [...MESSAGES] });
    assert.equal(keyed.hits[0].authorization, 'Bearer sk-test-123');

    const router2 = createRouter({ providers: [keylessProvider('free', free.url, 1)] });
    await router2.chat({ messages: [...MESSAGES] });
    assert.equal(free.hits[0].authorization, undefined);
  } finally {
    delete process.env.LLM_ROUTER_TEST_KEY;
    await keyed.close();
    await free.close();
  }
});

test('LLM_PROVIDERS reordena a cadeia; nomes desconhecidos avisam e são ignorados', async () => {
  const prev = process.env.LLM_PROVIDERS;
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (msg?: unknown) => {
    warnings.push(String(msg));
  };
  try {
    process.env.LLM_PROVIDERS = 'mistral,groq,naoexiste,gemini';
    const cfg = loadConfigFromEnv();
    assert.deepEqual(
      cfg.providers.map((p) => p.name),
      ['mistral', 'groq', 'gemini', 'openrouter', 'cerebras', 'github-models', 'pollinations', 'ollama'],
    );
    assert.deepEqual(
      cfg.providers.map((p) => p.priority),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.ok(
      warnings.some((w) => w.includes('naoexiste')),
      'esperava aviso sobre o nome desconhecido',
    );

    delete process.env.LLM_PROVIDERS;
    const cfgDefault = loadConfigFromEnv();
    assert.equal(cfgDefault.providers[0].name, 'gemini');
    assert.equal(cfgDefault.providers[7].name, 'ollama');
  } finally {
    console.warn = origWarn;
    if (prev === undefined) delete process.env.LLM_PROVIDERS;
    else process.env.LLM_PROVIDERS = prev;
  }
});

test('<NOME>_MODEL e <NOME>_BASE_URL fazem override à configuração por omissão', async () => {
  const prevModel = process.env.GROQ_MODEL;
  const prevBase = process.env.GROQ_BASE_URL;
  try {
    process.env.GROQ_MODEL = 'llama-override-test';
    process.env.GROQ_BASE_URL = 'http://127.0.0.1:9999/v1';
    const cfg = loadConfigFromEnv();
    const groq = cfg.providers.find((p) => p.name === 'groq');
    assert.ok(groq);
    assert.deepEqual(groq.models, ['llama-override-test']);
    assert.equal(groq.baseUrl, 'http://127.0.0.1:9999/v1');
    // Os restantes ficam intactos.
    const gemini = cfg.providers.find((p) => p.name === 'gemini');
    assert.deepEqual(gemini?.models, ['gemini-2.5-flash']);
  } finally {
    if (prevModel === undefined) delete process.env.GROQ_MODEL;
    else process.env.GROQ_MODEL = prevModel;
    if (prevBase === undefined) delete process.env.GROQ_BASE_URL;
    else process.env.GROQ_BASE_URL = prevBase;
  }
});

test('todos os fornecedores a falhar lança Error a mencionar cada fornecedor', async () => {
  const order: string[] = [];
  const a = await startMock('alfa', { status: 429, json: {} }, order);
  const b = await startMock('beta', { status: 503, json: {} }, order);
  try {
    const router = createRouter({
      providers: [keylessProvider('alfa', a.url, 1), keylessProvider('beta', b.url, 2)],
    });
    await assert.rejects(
      () => router.chat({ messages: [...MESSAGES] }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /alfa/);
        assert.match(err.message, /beta/);
        assert.match(err.message, /429/);
        assert.match(err.message, /503/);
        return true;
      },
    );
    assert.deepEqual(order, ['alfa', 'beta']);
  } finally {
    await a.close();
    await b.close();
  }
});

test('timeout num fornecedor lento faz failover para o seguinte', async () => {
  const order: string[] = [];
  const slow = await startMock('lento', { status: 200, json: chatCompletion('lento'), delayMs: 2000 }, order);
  const fast = await startMock('rapido', { status: 200, json: chatCompletion('rápido') }, order);
  try {
    const router = createRouter({
      providers: [keylessProvider('lento', slow.url, 1), keylessProvider('rapido', fast.url, 2)],
    });
    const res = await router.chat({ messages: [...MESSAGES], timeoutMs: 150 });
    assert.equal(res.provider, 'rapido');
    assert.equal(res.text, 'rápido');
  } finally {
    await slow.close();
    await fast.close();
  }
});
