import type { TtsEngine } from '../state';

interface Props {
  ttsEngine: TtsEngine;
  setTtsEngine: (engine: TtsEngine) => void;
  voice: string;
  setVoice: (voice: string) => void;
  rate: number;
  setRate: (rate: number) => void;
}

const VOICES: { value: string; label: string }[] = [
  { value: 'kokoro-pt-1', label: 'Kokoro pt-PT — voz 1 (vozes reais na Fase 2)' },
  { value: 'kokoro-pt-2', label: 'Kokoro pt-PT — voz 2 (vozes reais na Fase 2)' },
  { value: 'edge-pt-1', label: 'Edge-TTS pt-PT — voz 1 (vozes reais na Fase 2)' },
  { value: 'edge-pt-2', label: 'Edge-TTS pt-PT — voz 2 (vozes reais na Fase 2)' },
  { value: 'google-pt-1', label: 'Google pt-PT — voz 1 (vozes reais na Fase 2)' },
  { value: 'google-pt-2', label: 'Google pt-PT — voz 2 (vozes reais na Fase 2)' },
];

export default function StepVoice(props: Props) {
  const { ttsEngine, setTtsEngine, voice, setVoice, rate, setRate } = props;

  return (
    <div className="card">
      <h2>Voz</h2>
      <p className="muted">
        Motor de texto-para-fala e voz da narração. O áudio real é gerado na
        Fase 2 — aqui escolhes as preferências.
      </p>

      <div className="field">
        <span className="label">Motor de TTS</span>
        <div className="radio-group">
          <label className="radio">
            <input
              type="radio"
              name="tts-engine"
              checked={ttsEngine === 'kokoro'}
              onChange={() => setTtsEngine('kokoro')}
            />
            Kokoro (local)
          </label>
          <label className="radio">
            <input
              type="radio"
              name="tts-engine"
              checked={ttsEngine === 'edge'}
              onChange={() => setTtsEngine('edge')}
            />
            Edge-TTS
          </label>
          <label className="radio">
            <input
              type="radio"
              name="tts-engine"
              checked={ttsEngine === 'google'}
              onChange={() => setTtsEngine('google')}
            />
            Google Cloud TTS (chave)
          </label>
        </div>
      </div>

      <div className="field">
        <label htmlFor="voice">Voz</label>
        <select
          id="voice"
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
        >
          {VOICES.map((v) => (
            <option key={v.value} value={v.value}>
              {v.label}
            </option>
          ))}
        </select>
        <p className="hint">
          A lista final de vozes pt-PT (com pré-escuta) chega na Fase 2.
        </p>
      </div>

      <div className="field">
        <label htmlFor="rate">
          Velocidade da fala: <strong>{rate.toFixed(2)}×</strong>
        </label>
        <input
          id="rate"
          type="range"
          min={0.8}
          max={1.2}
          step={0.05}
          value={rate}
          onChange={(e) => setRate(Number(e.target.value))}
        />
      </div>
    </div>
  );
}
