/**
 * @shorts-forge/pipeline — orquestrador do pipeline em duas fases.
 *
 * - spec.ts:         Fase A — geração e validação da Spec via LLM (real).
 * - retime.ts:       Fase B — re-temporização com timestamps reais (real, puro).
 * - cache.ts:        cache de transcrições por sha256 do áudio (real).
 * - pythonBridge.ts: cliente HTTP para os serviços Python (real).
 * - jobs.ts:         modelo Job, JobStore em memória + bus de eventos (real).
 * - services.ts:     ciclo de vida dos serviços Python — arranque preguiçoso,
 *                    probe /health, paragem em idle/no encerramento (real).
 * - ttsConfig.ts:    resolução da config de TTS a partir do env (real).
 * - llmStatus.ts:    estados dos providers para GET /api/llm/status (real).
 * - orchestrate.ts:  PipelineOrchestrator — implementa a interface `Pipeline`
 *                    (ARCHITECTURE.md §4.3): Fase A → aprovação → Fase B.
 * - qc.ts:          controlo de qualidade automático (Fase 4): checks reais
 *                    ffprobe/FFmpeg entre o render e o `done`; escreve
 *                    outputs/<jobId>/qc-report.json (real).
 * - server.ts:       servidor HTTP do contrato REST congelado
 *                    (ARCHITECTURE.md §8) em http://localhost:3000/api (real).
 *
 * Limitação conhecida: os jobs vivem em memória — não sobrevivem a um
 * restart do servidor (a biblioteca de projetos durável é Fase 6).
 */

export { generateSpec, validateSpecJson, SPEC_SYSTEM_PROMPT, buildSpecSystemPrompt } from './spec.js';
export type { GenerateSpecOptions, SpecRouterLike } from './spec.js';

export { retimeSpec, totalDurationSec, DEFAULT_BREATH_MARGIN_SEC } from './retime.js';
export type { RetimeOptions } from './retime.js';

export { getCachedTranscript, putCachedTranscript, sha256File, defaultCacheDir } from './cache.js';

export { ServiceClients } from './pythonBridge.js';
export type { ServiceBaseUrls, TtsProvider } from './pythonBridge.js';

export { JobStore, ApiError, jobNotFound } from './jobs.js';
export type { Job, JobStatus, JobEvent, JobEventType, JobTtsChoice } from './jobs.js';

export { ServiceManager } from './services.js';
export type { ServiceManagerOptions, ServiceKind } from './services.js';

export { resolveTtsConfig } from './ttsConfig.js';
export type { TtsConfig } from './ttsConfig.js';

export {
  loadVoiceCatalog,
  resetVoiceCatalogCache,
  supportedLanguages,
  isSupportedLanguage,
  getLanguageEntry,
  whisperLanguageCode,
  resolveTtsForJob,
} from './voiceCatalog.js';
export type {
  CatalogVoice,
  LanguageEntry,
  VoiceCatalogData,
  ResolvedJobTts,
} from './voiceCatalog.js';

export { getProviderStatuses } from './llmStatus.js';
export type { ProviderStatus } from './llmStatus.js';

export { PipelineOrchestrator, defaultRenderVideo } from './orchestrate.js';
export type { Pipeline, OrchestratorDeps, RenderVideoFn } from './orchestrate.js';

export { jobOutputsDir, outputsRoot } from './outputs.js';

export {
  runQc,
  writeQcReport,
  readQcReport,
  writeCaptionsSrt,
  countSrtWords,
  countSpecWords,
  formatQcFailurePt,
  formatQcWarningsPt,
  qcToolsAvailable,
  QC_THRESHOLDS,
  QC_CHECK_NAMES,
  QC_REPORT_FILENAME,
  QC_CAPTION_FILENAME,
} from './qc.js';
export type {
  QcCheckName,
  QcCheckResult,
  QcReport,
  QcSegmentInfo,
  QcSeverity,
  QcThresholds,
  RunQcOptions,
} from './qc.js';

export { createServer, startServer, defaultBuildPreview } from './server.js';
export type { ServerDeps, StartServerOptions, StartedServer } from './server.js';
