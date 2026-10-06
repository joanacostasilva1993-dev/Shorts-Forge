// Ponto de entrada público de @shorts-forge/llm-router.
// Tipos partilhados + re-exportações da implementação.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  jsonMode?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ChatResult {
  text: string;
  provider: string;
  model: string;
}

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKeyEnv?: string | null;
  models: string[];
  priority: number;
  keyless?: boolean;
}

export interface RouterConfig {
  providers: ProviderConfig[];
}

export interface LLMRouter {
  chat(req: ChatRequest): Promise<ChatResult>;
  chatJson<T = unknown>(req: ChatRequest): Promise<{ data: T; provider: string; model: string }>;
}

export { createRouter } from './router.js';
export { loadConfigFromEnv, getDefaultTimeoutMs, DEFAULT_TIMEOUT_MS } from './config.js';
export { DEFAULT_PROVIDERS } from './providers.js';
