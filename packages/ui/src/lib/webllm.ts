/**
 * Adaptador WebLLM — "modo browser" do llm-router (ARCHITECTURE.md §6.3).
 *
 * Corre um modelo pequeno (WebGPU) totalmente no browser do utilizador:
 * sem chave, sem servidor, sem quotas. Útil quando não há chaves de API
 * nem Ollama instalado.
 *
 * IMPLEMENTAÇÃO REAL: usa @mlc-ai/web-llm via dynamic import() — o pacote
 * nunca entra no bundle principal (só é descarregado quando o utilizador
 * carrega o modelo). O modelo em si é descarregado na primeira utilização
 * e fica em cache do browser (Cache API) nas seguintes.
 */

import type { ChatMessage } from '@shorts-forge/shared';
import type { MLCEngine } from '@mlc-ai/web-llm';

/** Modelo pequeno por defeito; rápido de descarregar, bom para Specs curtas. */
export const DEFAULT_MODEL = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';

let engine: MLCEngine | null = null;
let loading: Promise<void> | null = null;
let loadedModelId: string | null = null;

/**
 * true se este browser consegue correr WebLLM.
 * WebGPU é o requisito (navigator.gpu).
 */
export function isSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'gpu' in navigator &&
    (navigator as Navigator & { gpu?: unknown }).gpu != null
  );
}

/** true se o modelo já foi carregado nesta sessão. */
export function isLoaded(): boolean {
  return engine !== null;
}

/** Qual o modelo carregado (null se nenhum). */
export function getLoadedModelId(): string | null {
  return loadedModelId;
}

/**
 * Carrega o modelo no browser. Chamadas concorrentes partilham o mesmo
 * carregamento. Só descarrega o pacote @mlc-ai/web-llm nesta altura
 * (dynamic import — nunca no bundle inicial).
 */
export function ensureModel(
  onProgress: (progress: number, text: string) => void,
  modelId: string = DEFAULT_MODEL,
): Promise<void> {
  if (engine) return Promise.resolve();
  if (loading) return loading;
  if (!isSupported()) {
    return Promise.reject(
      new Error(
        'WebGPU não disponível neste browser — o modo browser não funciona aqui. Usa Chrome/Edge 113+.',
      ),
    );
  }
  loading = (async () => {
    const webllm = await import('@mlc-ai/web-llm');
    const created = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (report) => {
        onProgress(report.progress, report.text);
      },
    });
    engine = created;
    loadedModelId = modelId;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

/**
 * Uma completion com o modelo carregado no browser.
 * Lança erro claro se o modelo ainda não foi carregado.
 */
export async function chat(messages: ChatMessage[]): Promise<string> {
  if (!engine) {
    throw new Error('Modelo ainda não carregado — chama ensureModel() primeiro.');
  }
  const reply = await engine.chat.completions.create({ messages });
  const content = reply.choices[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('Resposta inesperada do modelo no browser.');
  }
  return content;
}

/** Liberta a memória do modelo (opcional; raramente necessário). */
export async function unload(): Promise<void> {
  if (engine) {
    await engine.unload();
    engine = null;
    loadedModelId = null;
  }
}
