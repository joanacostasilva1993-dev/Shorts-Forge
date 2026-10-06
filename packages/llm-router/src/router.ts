// Lógica de failover: percorre os fornecedores por prioridade, um de cada vez.
// Sem dependências de runtime — apenas fetch + AbortController nativos.

import type {
  ChatRequest,
  ChatResult,
  LLMRouter,
  ProviderConfig,
  RouterConfig,
} from './index.js';
import { getDefaultTimeoutMs } from './config.js';

/** Estados HTTP que disparam failover imediato (quota/limite ou erro transitório). */
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

interface AttemptFailure {
  provider: string;
  error: string;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Extrai o texto de uma resposta OpenAI chat.completions (content string ou partes). */
function extractText(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const content = (choices[0] as { message?: { content?: unknown } })?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
          ? String((part as { text: unknown }).text)
          : '',
      )
      .join('');
  }
  return null;
}

/** Uma tentativa única contra um fornecedor. Lança em qualquer falha (o chamador faz failover). */
async function callProvider(
  provider: ProviderConfig,
  req: ChatRequest,
  apiKey: string | undefined,
): Promise<{ text: string; model: string }> {
  const model = provider.models[0] ?? 'default';
  const url = joinUrl(provider.baseUrl, 'chat/completions');
  const timeoutMs = req.timeoutMs ?? getDefaultTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body: Record<string, unknown> = { model, messages: req.messages };
    if (req.maxTokens != null) body.max_tokens = req.maxTokens;
    if (req.jsonMode) body.response_format = { type: 'json_object' };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`timeout after ${timeoutMs}ms`);
      }
      throw new Error(`network error: ${errorMessage(err)}`);
    }

    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).slice(0, 200);
      const suffix = snippet ? ` — ${snippet}` : '';
      if (res.status === 429) {
        throw new Error(`HTTP 429 Too Many Requests (quota/rate limit)${suffix}`);
      }
      if (TRANSIENT_STATUS.has(res.status)) {
        throw new Error(`HTTP ${res.status} ${res.statusText}${suffix}`);
      }
      // Outros 4xx: a chave pode ser inválida — também faz failover, mas regista-se a natureza.
      throw new Error(`HTTP ${res.status} ${res.statusText} (client error — failing over)${suffix}`);
    }

    const data: unknown = await res.json().catch(() => null);
    const text = extractText(data);
    if (text == null) {
      throw new Error('unexpected response shape: missing choices[0].message.content');
    }
    return { text, model };
  } finally {
    clearTimeout(timer);
  }
}

export function createRouter(config: RouterConfig): LLMRouter {
  const providers = [...config.providers].sort((a, b) => a.priority - b.priority);

  async function chat(req: ChatRequest): Promise<ChatResult> {
    const failures: AttemptFailure[] = [];
    const skipped: string[] = [];

    for (const provider of providers) {
      let apiKey: string | undefined;
      if (!provider.keyless) {
        apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
        if (!apiKey) {
          skipped.push(provider.name);
          continue; // sem chave => ignora silenciosamente, passa ao seguinte
        }
      }

      try {
        const { text, model } = await callProvider(provider, req, apiKey);
        return { text, provider: provider.name, model };
      } catch (err) {
        failures.push({ provider: provider.name, error: errorMessage(err) });
        // Failover: nunca se tenta o mesmo fornecedor duas vezes na mesma chamada.
      }
    }

    if (failures.length === 0 && skipped.length > 0) {
      throw new Error(
        `No LLM provider could be attempted — all skipped (required API key not set): ${skipped.join(', ')}`,
      );
    }
    if (failures.length === 0) {
      throw new Error('No LLM providers configured.');
    }
    const lines = failures.map((f) => `- ${f.provider}: ${f.error}`);
    let message = `All ${failures.length} attempted LLM provider(s) failed:\n${lines.join('\n')}`;
    if (skipped.length > 0) {
      message += `\nSkipped (required API key not set): ${skipped.join(', ')}`;
    }
    throw new Error(message);
  }

  async function chatJson<T = unknown>(
    req: ChatRequest,
  ): Promise<{ data: T; provider: string; model: string }> {
    const result = await chat({ ...req, jsonMode: true });
    try {
      const data = JSON.parse(result.text) as T;
      return { data, provider: result.provider, model: result.model };
    } catch {
      const snippet = result.text.slice(0, 200);
      throw new Error(`Provider "${result.provider}" returned invalid JSON: ${snippet}`);
    }
  }

  return { chat, chatJson };
}
