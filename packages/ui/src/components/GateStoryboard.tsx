import type { Segment } from '@shorts-forge/shared';
import { SAMPLE_DATA_LABEL } from '../mock';

interface Props {
  segments: Segment[];
  onContinue: () => void;
  onBack: () => void;
}

export default function GateStoryboard({ segments, onContinue, onBack }: Props) {
  return (
    <div className="card">
      <div className="gate-header">
        <h2>Storyboard</h2>
        <span className="badge mock">{SAMPLE_DATA_LABEL}</span>
      </div>
      <p className="muted">
        O plano visual de cada segmento: hook, palavras-chave e B-roll previsto.
      </p>

      <div className="story-grid">
        {segments.map((seg, i) => (
          <div key={seg.id} className="story-card">
            <div className="story-head">
              <strong>Plano {i + 1}</strong>
              <span className="duration">{seg.targetDurationSec.toFixed(1)} s</span>
            </div>
            {seg.hookLine && (
              <p className="hook-line">
                “{seg.hookLine}”
                {typeof seg.hookScore === 'number' && (
                  <span className="score">
                    {' '}
                    · força {Math.round(seg.hookScore * 100)}%
                  </span>
                )}
              </p>
            )}
            <div className="keywords">
              {seg.visualKeywords.map((k) => (
                <span key={k} className="chip">
                  {k}
                </span>
              ))}
            </div>
            <p className="broll">
              <span className="label-inline">B-roll:</span> {seg.brollDescription}
            </p>
            <p className="narr-preview muted">{seg.narration}</p>
          </div>
        ))}
      </div>

      <div className="actions">
        <button type="button" className="btn" onClick={onBack}>
          Voltar ao guião
        </button>
        <button type="button" className="btn primary" onClick={onContinue}>
          Aprovar storyboard
        </button>
      </div>
    </div>
  );
}
