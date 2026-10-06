import { useEffect, useState } from 'react';
import { SAMPLE_DATA_LABEL } from '../mock';

interface Props {
  onRestart: () => void;
  onBack: () => void;
}

const STEPS = [
  'A gerar narração (TTS)…',
  'A re-temporizar com os tempos reais…',
  'A resolver B-roll…',
  'A montar a timeline…',
];

export default function GateRender({ onRestart, onBack }: Props) {
  const [progress, setProgress] = useState(0);

  // Simulação puramente visual: nunca finge trabalho real.
  useEffect(() => {
    const id = window.setInterval(() => {
      setProgress((p) => Math.min(100, p + 4));
    }, 300);
    return () => window.clearInterval(id);
  }, []);

  const stepIndex = Math.min(
    STEPS.length - 1,
    Math.floor((progress / 100) * STEPS.length),
  );

  return (
    <div className="card">
      <div className="gate-header">
        <h2>Render</h2>
        <span className="badge mock">{SAMPLE_DATA_LABEL}</span>
      </div>
      <p className="muted">
        <strong>Simulação de progresso</strong> — nenhum vídeo está a ser
        renderizado. O render real (TTS + re-temporização + B-roll + FFmpeg)
        chega nas Fases 3/4.
      </p>

      <div className="render-status">
        <p aria-live="polite">{STEPS[stepIndex]}</p>
        <div
          className="progress big"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Progresso (simulação)"
        >
          <div className="progress-bar" style={{ width: `${progress}%` }} />
        </div>
        <p className="muted">{progress}%</p>
      </div>

      <div className="actions">
        <button type="button" className="btn" disabled title="Disponível quando o render for real">
          Descarregar MP4 (em breve)
        </button>
        <button type="button" className="btn" onClick={onBack}>
          Voltar ao storyboard
        </button>
        <button type="button" className="btn secondary" onClick={onRestart}>
          Começar de novo
        </button>
      </div>
    </div>
  );
}
