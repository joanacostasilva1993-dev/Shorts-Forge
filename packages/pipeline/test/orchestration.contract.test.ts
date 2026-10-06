/**
 * Contract tests for the orchestration API (frozen contract ARCHITECTURE.md §8).
 *
 * Base: http://localhost:3000/api (mesma origem da UI).
 * Cobertura:
 *   - POST /api/jobs            → 201 { job: Job } (status spec-draft)
 *   - GET  /api/jobs/:id        → 200 { job: Job }
 *   - POST /api/jobs/:id/spec   → 200 { spec: Spec } (Fase A)
 *   - PUT  /api/jobs/:id/spec   → 200 { job: Job } (status awaiting-approval)
 *   - POST /api/jobs/:id/render → 202 { job: Job } (status rendering)
 *   - GET  /api/jobs/:id/events → SSE; tipos de evento do conjunto congelado
 *   - erros                     → { error: { code, message } }, message em pt-PT
 *
 * A API ainda não está implementada (packages/pipeline/src/orchestrate.ts é
 * um stub) — por isso estes testes são SALTADOS com motivo quando nada
 * responde em :3000. Quando o engenheiro de orquestração ligar o servidor,
 * passam a correr sem alterações.
 *
 * A skipped-with-reason test is honest; a passing-but-meaningless test is a bug.
 * Run: npm test (tsc → node --test dist/test)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const API_BASE = 'http://localhost:3000/api';
const PROBE_TIMEOUT_MS = 1500;

const SKIP_API =
  'API de orquestração não está a correr em http://localhost:3000 — ' +
  'orquestração ainda não implementada (packages/pipeline/src/orchestrate.ts é stub)';

const FROZEN_JOB_STATUSES = [
  'spec-draft',
  'awaiting-approval',
  'rendering',
  'done',
  'failed',
] as const;
type JobStatus = (typeof FROZEN_JOB_STATUSES)[number];

/** Tipos de evento SSE do contrato congelado (§8 + JobEventType da UI). */
const FROZEN_EVENT_TYPES = [
  'progress',
  'spec-draft',
  'awaiting-approval',
  'rendering',
  'done',
  'failed',
] as const;

/** True quando ALGUMA resposta HTTP chega (mesmo 4xx/5xx). */
async function apiResponding(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/jobs/__probe__`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await res.arrayBuffer().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

function assertErrorEnvelope(body: unknown, where: string): void {
  assert.ok(
    typeof body === 'object' && body !== null,
    `${where}: corpo de erro deve ser um objeto`,
  );
  const err = (body as { error?: unknown }).error;
  assert.ok(
    typeof err === 'object' && err !== null,
    `${where}: erro deve ter a forma { error: { code, message } }`,
  );
  const e = err as Record<string, unknown>;
  assert.equal(typeof e['code'], 'string', `${where}: error.code é string`);
  assert.equal(typeof e['message'], 'string', `${where}: error.message é string`);
  assert.ok(
    (e['message'] as string).length > 0,
    `${where}: error.message não pode ser vazia (contrato: pt-PT)`,
  );
}

interface Job {
  id: string;
  status: JobStatus;
  input: unknown;
  spec?: unknown;
  progress: number;
  error?: string;
}

function assertJobShape(job: unknown, where: string): asserts job is Job {
  assert.ok(typeof job === 'object' && job !== null, `${where}: job é objeto`);
  const j = job as Record<string, unknown>;
  assert.equal(typeof j['id'], 'string', `${where}: job.id é string`);
  assert.ok(
    (FROZEN_JOB_STATUSES as readonly string[]).includes(j['status'] as string),
    `${where}: job.status ∈ ${FROZEN_JOB_STATUSES.join(', ')}`,
  );
  assert.equal(typeof j['progress'], 'number', `${where}: job.progress é number`);
  assert.ok('input' in j, `${where}: job tem input`);
}

async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* corpo não-JSON — os asserts abaixo falham com mensagem clara */
  }
  return { status: res.status, body };
}

describe('orchestration API — contrato congelado §8', () => {
  it('GET /api/jobs/:id desconhecido → 404 { error: { code, message } }', async (t) => {
    if (!(await apiResponding())) {
      t.skip(SKIP_API);
      return;
    }
    const { status, body } = await apiFetch('/jobs/id-que-nao-existe');
    assert.equal(status, 404, 'job desconhecido → 404');
    assertErrorEnvelope(body, 'GET /api/jobs/:id 404');
  });

  it('POST /api/jobs → 201 { job } em spec-draft', async (t) => {
    if (!(await apiResponding())) {
      t.skip(SKIP_API);
      return;
    }
    const { status, body } = await apiFetch('/jobs', {
      method: 'POST',
      body: JSON.stringify({
        input: { kind: 'topic', topic: 'hábitos matinais' },
        format: '9:16',
        language: 'pt-PT',
      }),
    });
    assert.equal(status, 201, 'criar job → 201');
    const job = (body as { job?: unknown }).job;
    assertJobShape(job, 'POST /api/jobs');
    assert.equal(job.status, 'spec-draft', 'job novo começa em spec-draft');
  });

  it('ciclo de vida: job → spec → aprovação → render', async (t) => {
    if (!(await apiResponding())) {
      t.skip(SKIP_API);
      return;
    }
    // 1. criar
    const created = await apiFetch('/jobs', {
      method: 'POST',
      body: JSON.stringify({
        input: { kind: 'topic', topic: 'hábitos matinais' },
        format: '9:16',
        language: 'pt-PT',
      }),
    });
    assert.equal(created.status, 201);
    const jobId = ((created.body as { job: Job }).job as Job).id;

    // 2. ler
    const got = await apiFetch(`/jobs/${encodeURIComponent(jobId)}`);
    assert.equal(got.status, 200);
    assertJobShape((got.body as { job: unknown }).job, 'GET /api/jobs/:id');
    assert.equal(((got.body as { job: Job }).job as Job).id, jobId);

    // 3. Fase A — gerar Spec (requer um LLM alcançável; sem chaves nem
    //    Ollama neste ambiente, o servidor responde 502 llm_failed — nesse
    //    caso o ciclo completo é saltado com motivo, não falha).
    const specRes = await apiFetch(`/jobs/${encodeURIComponent(jobId)}/spec`, {
      method: 'POST',
    });
    if (specRes.status >= 500) {
      const code = (specRes.body as { error?: { code?: string } }).error?.code;
      if (code === 'llm_failed') {
        t.skip(
          'nenhum provider LLM alcançável neste ambiente (sem chaves em .env, ' +
            'sem Ollama) — o ciclo completo tema→Spec→render requer um LLM; ' +
            'verificado manualmente quando houver provider',
        );
        return;
      }
    }
    assert.equal(specRes.status, 200);
    const spec = (specRes.body as { spec?: unknown }).spec as Record<string, unknown>;
    assert.ok(typeof spec === 'object' && spec !== null, 'POST /spec devolve { spec }');
    assert.ok(Array.isArray(spec['segments']), 'spec.segments é array');
    assert.ok((spec['segments'] as unknown[]).length >= 1, 'spec tem ≥1 segmento');

    // 4. editar + aprovar
    const approved = await apiFetch(`/jobs/${encodeURIComponent(jobId)}/spec`, {
      method: 'PUT',
      body: JSON.stringify({ spec }),
    });
    assert.equal(approved.status, 200);
    const approvedJob = (approved.body as { job: Job }).job as Job;
    assertJobShape(approvedJob, 'PUT /api/jobs/:id/spec');
    assert.equal(
      approvedJob.status,
      'awaiting-approval',
      'após PUT da spec → awaiting-approval',
    );

    // 5. render sem aprovação explícita rejeita (regra TEST_PLAN §3.4);
    //    aqui a spec foi aprovada, por isso aceita-se 202.
    const renderRes = await apiFetch(`/jobs/${encodeURIComponent(jobId)}/render`, {
      method: 'POST',
    });
    assert.equal(renderRes.status, 202, 'POST /render após aprovação → 202');
    const renderingJob = (renderRes.body as { job: Job }).job as Job;
    assertJobShape(renderingJob, 'POST /api/jobs/:id/render');
    assert.equal(renderingJob.status, 'rendering');
  });

  it('POST /api/jobs/:id/render sem aprovação → 4xx { error: { code, message } }', async (t) => {
    if (!(await apiResponding())) {
      t.skip(SKIP_API);
      return;
    }
    const created = await apiFetch('/jobs', {
      method: 'POST',
      body: JSON.stringify({
        input: { kind: 'topic', topic: 'teste sem aprovação' },
        format: '9:16',
        language: 'pt-PT',
      }),
    });
    assert.equal(created.status, 201);
    const jobId = ((created.body as { job: Job }).job as Job).id;
    const renderRes = await apiFetch(`/jobs/${encodeURIComponent(jobId)}/render`, {
      method: 'POST',
    });
    assert.ok(
      renderRes.status >= 400 && renderRes.status < 500,
      `render sem aprovação → 4xx (foi ${renderRes.status})`,
    );
    assertErrorEnvelope(renderRes.body, 'POST /render sem aprovação');
  });

  it('POST /api/jobs com corpo inválido → 4xx { error: { code, message } }', async (t) => {
    if (!(await apiResponding())) {
      t.skip(SKIP_API);
      return;
    }
    const { status, body } = await apiFetch('/jobs', {
      method: 'POST',
      body: JSON.stringify({ input: { kind: 'topic' } }), // sem topic, sem format
    });
    assert.ok(status >= 400 && status < 500, `corpo inválido → 4xx (foi ${status})`);
    assertErrorEnvelope(body, 'POST /api/jobs inválido');
  });

  it('GET /api/jobs/:id/events emite SSE com tipos do contrato', async (t) => {
    if (!(await apiResponding())) {
      t.skip(SKIP_API);
      return;
    }
    const created = await apiFetch('/jobs', {
      method: 'POST',
      body: JSON.stringify({
        input: { kind: 'topic', topic: 'teste sse' },
        format: '9:16',
        language: 'pt-PT',
      }),
    });
    assert.equal(created.status, 201);
    const jobId = ((created.body as { job: Job }).job as Job).id;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    const seen: string[] = [];
    try {
      const res = await fetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}/events`, {
        headers: { accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      assert.ok(res.ok, 'SSE endpoint responde 2xx');
      const reader = res.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const read = await reader.read().catch(() => null);
          if (!read || read.done) break;
          buf += decoder.decode(read.value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of chunk.split('\n')) {
              const m = /^data:\s*(.*)$/.exec(line.trim());
              if (!m?.[1]) continue;
              const evt = JSON.parse(m[1]) as { type?: unknown; job?: unknown };
              assert.ok(
                (FROZEN_EVENT_TYPES as readonly string[]).includes(evt.type as string),
                `tipo de evento SSE ∈ contrato (foi ${JSON.stringify(evt.type)})`,
              );
              assert.ok(typeof evt.job === 'object' && evt.job !== null, 'evento SSE traz job');
              seen.push(evt.type as string);
            }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') throw err;
    } finally {
      clearTimeout(timer);
    }
    if (seen.length === 0) {
      t.skip(
        'nenhum evento SSE observado em 3.5s sem atividade no job — ' +
          'verificação manual: acompanhar um render até done',
      );
      return;
    }
  });

  it('GET /api/llm/status → { providers: ProviderStatus[] }', async (t) => {
    if (!(await apiResponding())) {
      t.skip(SKIP_API);
      return;
    }
    const { status, body } = await apiFetch('/llm/status');
    assert.equal(status, 200);
    const providers = (body as { providers?: unknown }).providers;
    assert.ok(Array.isArray(providers), 'llm/status devolve { providers: [] }');
    for (const p of providers as Record<string, unknown>[]) {
      assert.equal(typeof p['name'], 'string');
      assert.equal(typeof p['reachable'], 'boolean');
      assert.equal(typeof p['keyless'], 'boolean');
    }
  });
});
