// Definições por omissão dos 8 fornecedores gratuitos, por ordem de prioridade.
// A ordem do array é a ordem de prioridade (1 = mais prioritário).
// Cada fornecedor aceita overrides via variáveis de ambiente (ver config.ts).

import type { ProviderConfig } from './index.js';

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    name: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKeyEnv: 'GEMINI_API_KEY',
    models: ['gemini-2.5-flash'],
    priority: 1,
  },
  {
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    models: ['llama-3.3-70b-versatile'],
    priority: 2,
  },
  {
    name: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    models: ['qwen/qwen3-235b-a22b:free'],
    priority: 3,
  },
  {
    name: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    models: ['mistral-small-latest'],
    priority: 4,
  },
  {
    name: 'cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    models: ['llama-3.3-70b'],
    priority: 5,
  },
  {
    name: 'github-models',
    baseUrl: 'https://models.github.ai/inference',
    apiKeyEnv: 'GITHUB_TOKEN',
    models: ['openai/gpt-4o-mini'],
    priority: 6,
  },
  {
    name: 'pollinations',
    baseUrl: 'https://text.pollinations.ai/openai',
    apiKeyEnv: null,
    models: ['openai'],
    priority: 7,
    keyless: true,
  },
  {
    name: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    apiKeyEnv: null,
    models: ['qwen3:8b'],
    priority: 8,
    keyless: true,
  },
];
