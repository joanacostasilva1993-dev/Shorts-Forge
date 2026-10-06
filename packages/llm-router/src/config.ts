// Carregamento da configuração a partir de variáveis de ambiente.

import type { ProviderConfig, RouterConfig } from './index.js';
import { DEFAULT_PROVIDERS } from './providers.js';

export const DEFAULT_TIMEOUT_MS = 60000;

/** Timeout global por omissão (ms). Override via LLM_TIMEOUT_MS; inválido => 60000. */
export function getDefaultTimeoutMs(): number {
  const raw = process.env.LLM_TIMEOUT_MS;
  if (raw == null || raw.trim() === '') return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TIMEOUT_MS;
}

/** 'github-models' -> 'GITHUB_MODELS' (prefixo para <NAME>_BASE_URL / <NAME>_MODEL). */
function envPrefix(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function applyEnvOverrides(p: ProviderConfig): ProviderConfig {
  const prefix = envPrefix(p.name);
  const baseUrl = process.env[`${prefix}_BASE_URL`]?.trim();
  const model = process.env[`${prefix}_MODEL`]?.trim();
  return {
    ...p,
    baseUrl: baseUrl ? baseUrl : p.baseUrl,
    models: model ? [model] : [...p.models],
  };
}

/**
 * Constrói o RouterConfig a partir do ambiente:
 * - parte de DEFAULT_PROVIDERS (clonados);
 * - aplica <NAME>_BASE_URL e <NAME>_MODEL a cada fornecedor;
 * - LLM_PROVIDERS="groq,gemini,..." reordena a cadeia (nomes desconhecidos
 *   são ignorados com um aviso no console; os restantes mantêm a ordem relativa);
 * - renumera as prioridades de 1..N pela ordem final.
 * As chaves de API são lidas em tempo de chamada via `apiKeyEnv`, não aqui.
 */
export function loadConfigFromEnv(): RouterConfig {
  let providers = DEFAULT_PROVIDERS.map(applyEnvOverrides);

  const orderRaw = process.env.LLM_PROVIDERS;
  if (orderRaw != null && orderRaw.trim() !== '') {
    const wanted = orderRaw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const byName = new Map(providers.map((p) => [p.name.toLowerCase(), p]));
    const seen = new Set<string>();
    const ordered: ProviderConfig[] = [];
    for (const name of wanted) {
      const p = byName.get(name);
      if (!p) {
        console.warn(`[llm-router] Unknown provider "${name}" in LLM_PROVIDERS — ignoring.`);
        continue;
      }
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      ordered.push(p);
    }
    for (const p of providers) {
      if (!seen.has(p.name)) ordered.push(p);
    }
    providers = ordered;
  }

  providers = providers.map((p, i) => ({ ...p, priority: i + 1 }));
  return { providers };
}
