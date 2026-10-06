/**
 * Job model + in-memory store + event bus for the pipeline orchestrator.
 *
 * A Job is the unit of work the UI drives through the frozen REST contract
 * (ARCHITECTURE.md §8): create → Phase A (spec) → approve → Phase B (render).
 * Events are fanned out to SSE subscribers (`GET /api/jobs/:id/events`)
 * and to programmatic `AsyncIterable` consumers (`Pipeline.specEvents`).
 *
 * Persistence is IN-MEMORY (a Map). This is a documented known limitation:
 * jobs do not survive a server restart. The durable project library is
 * Phase 6 work (ROADMAP.md).
 */

import { randomUUID } from 'node:crypto';
import type { PipelineInput, Spec, VideoFormat } from '@shorts-forge/shared';

/** Lifecycle states of a pipeline job (frozen contract — ARCHITECTURE.md §8). */
export type JobStatus =
  | 'spec-draft'
  | 'awaiting-approval'
  | 'rendering'
  | 'done'
  | 'failed';

/** SSE event types (frozen contract — ARCHITECTURE.md §8). */
export type JobEventType =
  | 'spec-draft'
  | 'awaiting-approval'
  | 'rendering'
  | 'done'
  | 'failed'
  | 'progress';

/**
 * A pipeline job. `format`/`language` come from `POST /api/jobs` and travel
 * with the job so Phase A/B stay consistent. `outputPath` is set by the
 * Phase 4 video assembly (unset until then — `/download` 409s honestly).
 */
export interface Job {
  id: string;
  status: JobStatus;
  input: PipelineInput;
  format: VideoFormat;
  language: string;
  spec?: Spec;
  /** 0..1 overall progress. */
  progress: number;
  /** pt-PT failure reason (only when status === 'failed'). */
  error?: string;
  /** Absolute path of the final MP4 (Phase 4). */
  outputPath?: string;
  createdAt: string;
  updatedAt: string;
}

/** One event on a job's stream. `message` is an optional pt-PT human note. */
export interface JobEvent {
  type: JobEventType;
  job: Job;
  message?: string;
}

/**
 * HTTP-mapped error. Routes translate these into the frozen error shape
 * `{ error: { code, message } }` with `message` in pt-PT.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Shorthand for the common 404. */
export function jobNotFound(id: string): ApiError {
  return new ApiError('job_not_found', 404, `Job não encontrado: ${id}.`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function snapshot(job: Job): Job {
  // structuredClone keeps callers from mutating store state.
  return structuredClone(job);
}

/**
 * In-memory job store with a per-job pub/sub event bus.
 * Not thread-safe by design — Node runs one event loop; all mutations are
 * synchronous except the async orchestration steps that own a job.
 */
export class JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Map<string, Set<(event: JobEvent) => void>>();

  /** Creates a job in `spec-draft` status. */
  create(input: PipelineInput, format: VideoFormat, language: string): Job {
    const id = `job-${randomUUID()}`;
    const now = nowIso();
    const job: Job = {
      id,
      status: 'spec-draft',
      input,
      format,
      language,
      progress: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(id, job);
    return snapshot(job);
  }

  /** Returns a snapshot; throws ApiError(404) when unknown. */
  get(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw jobNotFound(id);
    return snapshot(job);
  }

  has(id: string): boolean {
    return this.jobs.has(id);
  }

  /** Applies a partial update and refreshes `updatedAt`. Returns a snapshot. */
  update(id: string, patch: Partial<Omit<Job, 'id' | 'createdAt'>>): Job {
    const job = this.jobs.get(id);
    if (!job) throw jobNotFound(id);
    const next: Job = { ...job, ...patch, id: job.id, createdAt: job.createdAt, updatedAt: nowIso() };
    // Exact-optional hygiene: an explicit `undefined` in the patch clears the field;
    // an absent key leaves the current value untouched.
    if ('error' in patch && patch.error === undefined) delete next.error;
    if ('spec' in patch && patch.spec === undefined) delete next.spec;
    if ('outputPath' in patch && patch.outputPath === undefined) delete next.outputPath;
    this.jobs.set(id, next);
    return snapshot(next);
  }

  /** Marks the job failed with a pt-PT reason. Returns a snapshot. */
  fail(id: string, message: string): Job {
    return this.update(id, { status: 'failed', error: message });
  }

  /**
   * Subscribes to a job's events. The callback receives immutable snapshots.
   * Returns an unsubscribe function. Unknown job → throws ApiError(404).
   */
  subscribe(id: string, cb: (event: JobEvent) => void): () => void {
    if (!this.jobs.has(id)) throw jobNotFound(id);
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(cb);
    return () => {
      const s = this.listeners.get(id);
      if (s) {
        s.delete(cb);
        if (s.size === 0) this.listeners.delete(id);
      }
    };
  }

  /** Builds a JobEvent from the current state and notifies subscribers. */
  emit(id: string, type: JobEventType, message?: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    const event: JobEvent = message
      ? { type, job: snapshot(job), message }
      : { type, job: snapshot(job) };
    const set = this.listeners.get(id);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(event);
      } catch {
        // A broken subscriber must never break the pipeline.
      }
    }
  }
}
