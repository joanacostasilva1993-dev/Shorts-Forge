import type { Segment } from '@shorts-forge/shared';
import { SAMPLE_DATA_LABEL, mockRegenerateSegment } from '../mock';

interface Props {
  segments: Segment[];
  onChange: (segments: Segment[]) => void;
  onContinue: () => void;
  onBack: () => void;
}

export default function GateScript({ segments, onChange, onContinue, onBack }: Props) {
  const updateNarration = (id: string, narration: string) => {
    onChange(segments.map((s) => (s.id === id ? { ...s, narration } : s)));
  };

  const regenerate = (id: string) => {
    onChange(segments.map((s) => (s.id === id ? mockRegenerateSegment(s) : s)));
  };

  return (
    <div className="card">
      <div className="gate-header">
        <h2>Rever guião</h2>
        <span className="badge mock">{SAMPLE_DATA_LABEL}</span>
      </div>
      <p className="muted">
        Edita a narração de cada plano. Nada renderiza sem a tua aprovação — o
        guião é o contrato do vídeo.
      </p>

      {segments.map((seg, i) => (
        <div key={seg.id} className="segment">
          <div className="segment-head">
            <strong>Plano {i + 1}</strong>
            <span className="muted">{seg.id}</span>
          </div>
          <label htmlFor={`narr-${seg.id}`} className="sr-only">
            Narração do plano {i + 1}
          </label>
          <textarea
            id={`narr-${seg.id}`}
            rows={3}
            value={seg.narration}
            onChange={(e) => updateNarration(seg.id, e.target.value)}
          />
          <button
            type="button"
            className="btn secondary small"
            onClick={() => regenerate(seg.id)}
          >
            Regenerar segmento (exemplo)
          </button>
        </div>
      ))}

      <p className="hint">
        "Regenerar segmento" é uma simulação: só acrescenta "(rev. 2)" ao texto.
        A regeneração real via LLM chega na Fase 2.
      </p>

      <div className="actions">
        <button type="button" className="btn" onClick={onBack}>
          Voltar ao assistente
        </button>
        <button type="button" className="btn primary" onClick={onContinue}>
          Aprovar e ver storyboard
        </button>
      </div>
    </div>
  );
}
