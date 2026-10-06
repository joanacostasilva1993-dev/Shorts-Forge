import { useState } from 'react';
import type { PlatformPresetId } from '@shorts-forge/shared';
import type { LlmMode } from '../state';
import { UI_PRESETS } from '../lib/presets';
import { DEFAULT_MODEL, chat, ensureModel, isLoaded, isSupported } from '../lib/webllm';

interface Props {
  preset: PlatformPresetId;
  setPreset: (preset: PlatformPresetId) => void;
  llmMode: LlmMode;
  setLlmMode: (mode: LlmMode) => void;
  onGenerate: () => void;
}

const LLM_MODES: { value: LlmMode; label: string; description: string }[] = [
  {
    value: 'cloud',
    label: 'Cadeia cloud (chaves)',
    description: 'Usa as tuas chaves gratuitas (Gemini, Groq, …) com failover. Fase 2.',
  },
  {
    value: 'keyless',
    label: 'Sem chave (Pollinations)',
    description: 'Zero configuração: o router usa o provider sem chave. Fase 2.',
  },
  {
    value: 'browser',
    label: 'No browser (WebGPU, sem chave)',
    description:
      'Modelo pequeno corre neste browser via WebGPU. Sem chave, sem servidor, sem quotas.',
  },
];

function WebllmPanel() {
  const supported = isSupported();
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [answering, setAnswering] = useState(false);

  const load = async () => {
    setLoading(true);
    setStatus('A descarregar o modelo… (primeira vez demora)');
    try {
      await ensureModel((p, text) => {
        setProgress(p);
        if (text) setStatus(text);
      });
      setStatus(`Modelo pronto (${DEFAULT_MODEL}).`);
    } catch (err) {
      setStatus(`Falhou: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const ask = async () => {
    if (!prompt.trim()) return;
    setAnswering(true);
    setAnswer(null);
    try {
      const reply = await chat([
        {
          role: 'system',
          content:
            'És um assistente que responde em português europeu, de forma curta.',
        },
        { role: 'user', content: prompt },
      ]);
      setAnswer(reply);
    } catch (err) {
      setAnswer(`Falhou: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAnswering(false);
    }
  };

  return (
    <div className="webllm-panel">
      <h3>Modo browser (WebGPU)</h3>
      {!supported ? (
        <p className="warning">
          WebGPU não detetado neste browser — o modo browser não funciona aqui.
          Usa Chrome ou Edge 113+.
        </p>
      ) : (
        <>
          <p className="muted">
            WebGPU disponível. O modelo corre 100% neste browser — nada sai do
            teu computador.
          </p>
          <button
            type="button"
            className="btn secondary"
            onClick={load}
            disabled={loading || isLoaded()}
          >
            {isLoaded()
              ? 'Modelo carregado'
              : loading
                ? 'A carregar…'
                : 'Carregar modelo no browser (demonstração)'}
          </button>
          {loading && (
            <div className="progress">
              <div
                className="progress-bar"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          )}
          {status && <p className="muted">{status}</p>}
          {isLoaded() && (
            <div className="field">
              <label htmlFor="webllm-prompt">Experimentar o modelo</label>
              <div className="row">
                <input
                  id="webllm-prompt"
                  type="text"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Ex.: Escreve um hook para um vídeo sobre manhãs"
                />
                <button
                  type="button"
                  className="btn secondary"
                  onClick={ask}
                  disabled={answering}
                >
                  {answering ? 'A pensar…' : 'Perguntar'}
                </button>
              </div>
              {answer && <p className="answer">{answer}</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function StepFormat({
  preset,
  setPreset,
  llmMode,
  setLlmMode,
  onGenerate,
}: Props) {
  return (
    <div className="card">
      <h2>Plataforma e geração</h2>
      <p className="muted">
        Escolhe a plataforma de destino — a resolução, as margens das
        legendas e o alvo de loudness ajustam-se automaticamente. A geração
        real da Spec (Fase A) corre na Fase 2 — por agora vês as portas de
        revisão com dados de exemplo.
      </p>

      <div className="field">
        <span className="label">Plataforma de destino</span>
        <div className="preset-grid" role="group" aria-label="Plataforma de destino">
          {UI_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={preset === p.id ? 'preset-card active' : 'preset-card'}
              onClick={() => setPreset(p.id)}
              aria-pressed={preset === p.id}
            >
              <span className="preset-label">{p.label}</span>
              <span className="preset-meta">{p.meta}</span>
              <span className="preset-desc">{p.description}</span>
            </button>
          ))}
        </div>
        <p className="hint">
          O preset define a resolução e mantém as legendas fora das zonas de
          interface de cada plataforma (barra de ações, progresso, descrição).
        </p>
      </div>

      <div className="field">
        <label htmlFor="llm-mode">Modo de LLM</label>
        <select
          id="llm-mode"
          value={llmMode}
          onChange={(e) => setLlmMode(e.target.value as LlmMode)}
        >
          {LLM_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <p className="hint">
          {LLM_MODES.find((m) => m.value === llmMode)?.description}
        </p>
      </div>

      {llmMode === 'browser' && <WebllmPanel />}

      <button type="button" className="btn primary big" onClick={onGenerate}>
        Gerar vídeo
      </button>
    </div>
  );
}
