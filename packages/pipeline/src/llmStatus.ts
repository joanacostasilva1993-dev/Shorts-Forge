/**
 * `GET /api/llm/status` backing: provider statuses for the UI's debug view.
 *
 * The llm-router package has no `status()` of its own, so this module builds
 * the view from the router config (`loadConfigFromEnv()`) plus a cheap
 * reachability probe per provider: any HTTP response (even 4xx) counts as
 * reachable; connection refused / DNS failure / timeout counts as not.
 * Providers whose API key is not configured are reported unreachable with a
 * `quotaHint` — the router would skip them silently, and the UI should say why.
 *
 * Never throws: on any unexpected failure it returns an empty list rather
 * than breaking the debug endpoint.
 */

import { loadConfigFromEnv } from '@shorts-forge/llm-router';

export interface ProviderStatus {
  name: string;
  reachable: boolean;
  keyless: boolean;
  quotaHint?: string;
}

const PROBE_TIMEOUT_MS = 2500;

async function probeReachable(baseUrl: string): Promise<boolean> {
  try {
    // Any HTTP response at all means the host is up; the body is irrelevant.
    await fetch(baseUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

/** Provider statuses for `GET /api/llm/status`. Never throws. */
export async function getProviderStatuses(): Promise<ProviderStatus[]> {
  try {
    const { providers } = loadConfigFromEnv();
    return await Promise.all(
      providers.map(async (p) => {
        const keyless = p.keyless === true;
        const hasKey = keyless || !p.apiKeyEnv || !!process.env[p.apiKeyEnv];
        const reachable = hasKey ? await probeReachable(p.baseUrl) : false;
        const status: ProviderStatus = {
          name: p.name,
          reachable,
          keyless,
        };
        if (!hasKey) {
          status.quotaHint = 'chave API não configurada — o router ignora este provider';
        }
        return status;
      }),
    );
  } catch {
    return [];
  }
}
