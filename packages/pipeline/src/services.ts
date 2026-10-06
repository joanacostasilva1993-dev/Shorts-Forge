/**
 * Lifecycle manager for the Phase 2 Python services (transcription :8001,
 * TTS :8002).
 *
 * Strategy (ARCHITECTURE.md §3 / §4.4):
 *  - lazy: nothing is spawned until the first `ensureTranscription()` /
 *    `ensureTts()` call (i.e. the first job that needs it);
 *  - probe: `GET /health` on both services via `ServiceClients.health()`;
 *  - spawn: only when a spawn command is known (see below); then wait for
 *    `/health` with a bounded deadline — never hang silently;
 *  - idle: children unused for `idleTimeoutMs` are killed;
 *  - stop: `shutdown()` kills every child (wired to SIGINT/SIGTERM by the
 *    server).
 *
 * Spawn command resolution (documented contract for the TTS/transcription
 * engineers):
 *  1. `TRANSCRIPTION_SERVICE_CMD` / `TTS_SERVICE_CMD` env vars
 *     (a full shell command, e.g. `python3 /opt/sf/transcribe.py --port 8001`);
 *  2. fallback: `<repo>/packages/transcription/service.py` (resp. `tts`)
 *     invoked as `python3 <script> --port <port>` when that file exists;
 *  3. otherwise spawning is impossible → fail fast with an actionable
 *     pt-PT error (run the service / `npm run models:download`).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServiceClients } from './pythonBridge.js';

export type ServiceKind = 'transcription' | 'tts';

export interface ServiceManagerOptions {
  /**
   * Kill a spawned child after this long without use. Default 10 min.
   * 0 disables the idle reaper (children live until `shutdown()`).
   */
  idleTimeoutMs?: number;
  /** Max wait for /health after spawning. Default 90 s. */
  spawnTimeoutMs?: number;
  /** How often the idle reaper runs. Default 30 s. */
  checkIntervalMs?: number;
  /** Set false in tests to skip spawning entirely. Default true. */
  allowSpawn?: boolean;
}

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SPAWN_TIMEOUT_MS = 90 * 1000;
const DEFAULT_CHECK_INTERVAL_MS = 30 * 1000;
const HEALTH_POLL_MS = 750;

interface Managed {
  kind: ServiceKind;
  child: ChildProcess | null;
  lastUsedAt: number;
  baseUrl: string;
}

function serviceLabel(kind: ServiceKind): string {
  return kind === 'transcription' ? 'transcrição' : 'TTS';
}

function envVarFor(kind: ServiceKind): string {
  return kind === 'transcription' ? 'TRANSCRIPTION_SERVICE_CMD' : 'TTS_SERVICE_CMD';
}

function portFromBaseUrl(baseUrl: string, fallback: number): number {
  try {
    const port = Number(new URL(baseUrl).port);
    return Number.isFinite(port) && port > 0 ? port : fallback;
  } catch {
    return fallback;
  }
}

/** Walks up from this module to the repo root (package.json "shorts-forge"). */
function findRepoRootSync(): string | null {
  // This module lives at <repo>/packages/pipeline/(dist/)src → repo root is
  // three (src) or two (dist/src) levels up. Resolve both, pick the one whose
  // package.json is named "shorts-forge".
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '..', '..', '..'), resolve(here, '..', '..')];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')) as {
        name?: unknown;
      };
      if (pkg.name === 'shorts-forge') return candidate;
    } catch {
      // Not the repo root — try the next candidate.
    }
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class ServiceManager {
  private readonly clients: ServiceClients;
  private readonly idleTimeoutMs: number;
  private readonly spawnTimeoutMs: number;
  private readonly allowSpawn: boolean;
  private readonly managed: Record<ServiceKind, Managed>;
  private reaper: NodeJS.Timeout | null = null;
  private shutDown = false;

  constructor(clients: ServiceClients, opts: ServiceManagerOptions = {}) {
    this.clients = clients;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.spawnTimeoutMs = opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
    this.allowSpawn = opts.allowSpawn ?? true;
    this.managed = {
      transcription: { kind: 'transcription', child: null, lastUsedAt: 0, baseUrl: clients.transcriptionBase },
      tts: { kind: 'tts', child: null, lastUsedAt: 0, baseUrl: clients.ttsBase },
    };
    const checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    if (this.idleTimeoutMs > 0 && checkIntervalMs > 0) {
      this.reaper = setInterval(() => void this.reapIdle(), checkIntervalMs);
      this.reaper.unref();
    }
  }

  /** Ensures the transcription service answers /health (spawning if needed). */
  async ensureTranscription(): Promise<void> {
    await this.ensure('transcription');
  }

  /** Ensures the TTS service answers /health (spawning if needed). */
  async ensureTts(): Promise<void> {
    await this.ensure('tts');
  }

  /** Kills every spawned child and stops the idle reaper. */
  async shutdown(): Promise<void> {
    this.shutDown = true;
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    for (const kind of ['transcription', 'tts'] as const) {
      this.kill(kind);
    }
  }

  private async ensure(kind: ServiceKind): Promise<void> {
    if (this.shutDown) {
      throw new Error('o gestor de serviços foi encerrado');
    }
    const m = this.managed[kind];
    if (await this.healthy(kind)) {
      m.lastUsedAt = Date.now();
      return;
    }
    if (m.child && !m.child.killed && m.child.exitCode === null) {
      // A child is already starting; give it the remaining spawn budget.
      await this.waitForHealth(kind, this.spawnTimeoutMs);
      m.lastUsedAt = Date.now();
      return;
    }
    const cmd = this.resolveSpawnCommand(kind);
    if (!cmd || !this.allowSpawn) {
      throw new Error(this.unavailableMessage(kind, cmd === null));
    }
    this.spawn(kind, cmd);
    try {
      await this.waitForHealth(kind, this.spawnTimeoutMs);
    } catch (err) {
      this.kill(kind);
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `não foi possível arrancar o serviço de ${serviceLabel(kind)} ` +
          `(comando: ${cmd}). Verifica o Python e os modelos ` +
          `(\`npm run models:download\`). Detalhe: ${detail}`,
      );
    }
    m.lastUsedAt = Date.now();
  }

  private async healthy(kind: ServiceKind): Promise<boolean> {
    try {
      const h = await this.clients.health();
      return kind === 'transcription' ? h.transcription : h.tts;
    } catch {
      return false;
    }
  }

  private async waitForHealth(kind: ServiceKind, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.healthy(kind)) return;
      const m = this.managed[kind];
      if (m.child && m.child.exitCode !== null) {
        throw new Error(`o processo terminou (código ${m.child.exitCode}) antes de responder a /health`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`tempo esgotado à espera de /health (${timeoutMs}ms)`);
      }
      await sleep(HEALTH_POLL_MS);
    }
  }

  /**
   * Resolves the spawn command for a service, or null when spawning is
   * impossible (→ the caller fails with the actionable pt-PT error).
   */
  private resolveSpawnCommand(kind: ServiceKind): string | null {
    const fromEnv = (process.env[envVarFor(kind)] ?? '').trim();
    if (fromEnv) return fromEnv;
    const root = findRepoRootSync();
    if (root) {
      const script = join(root, 'packages', kind, 'service.py');
      if (existsSync(script)) {
        const port = portFromBaseUrl(
          this.managed[kind].baseUrl,
          kind === 'transcription' ? 8001 : 8002,
        );
        return `python3 ${JSON.stringify(script)} --port ${port}`;
      }
    }
    return null;
  }

  private spawn(kind: ServiceKind, cmd: string): void {
    const m = this.managed[kind];
    const child = spawn(cmd, {
      shell: true,
      stdio: 'ignore',
      detached: false,
      env: { ...process.env },
    });
    child.on('error', () => {
      // The waitForHealth loop observes exitCode / timeout and reports.
    });
    child.unref();
    m.child = child;
    m.lastUsedAt = Date.now();
  }

  private kill(kind: ServiceKind): void {
    const m = this.managed[kind];
    const child = m.child;
    m.child = null;
    if (child && child.exitCode === null) {
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            if (child.exitCode === null) child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, 3000).unref();
      } catch {
        /* already gone */
      }
    }
  }

  private reapIdle(): void {
    if (this.shutDown || this.idleTimeoutMs <= 0) return;
    const now = Date.now();
    for (const kind of ['transcription', 'tts'] as const) {
      const m = this.managed[kind];
      if (m.child && now - m.lastUsedAt > this.idleTimeoutMs) {
        this.kill(kind);
      }
    }
  }

  private unavailableMessage(kind: ServiceKind, noSpawnCommand: boolean): string {
    const m = this.managed[kind];
    const label = serviceLabel(kind);
    const base =
      `serviço de ${label} indisponível em ${m.baseUrl} — ` +
      `o pipeline não arranca serviços sozinho sem um comando configurado. `;
    const hint = noSpawnCommand
      ? `Define ${envVarFor(kind)} com o comando de arranque do serviço Python da Fase 2, ` +
        `ou corre \`npm run models:download\` para instalar os modelos.`
      : `Verifica se o serviço Python da Fase 2 está a correr e acessível.`;
    return base + hint;
  }
}