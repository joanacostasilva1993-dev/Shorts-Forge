import type { TtsEngine } from '../state';
import {
  voicesForLanguage,
  defaultVoiceFor,
  providerLabel,
  type TtsProvider,
} from '../lib/voices';

interface Props {
  language: string;
  ttsEngine: TtsEngine;
  setTtsEngine: (engine: TtsEngine) => void;
  voice: string;
  setVoice: (voice: string) => void;
  rate: number;
  setRate: (rate: number) => void;
}

const ENGINE_OF_PROVIDER: Record<TtsProvider, TtsEngine> = {
  kokoro: 'kokoro',
  'edge-tts': 'edge',
  google: 'google',
};

const PROVIDER_OF_ENGINE: Record<TtsEngine, TtsProvider> = {
  kokoro: 'kokoro',
  edge: 'edge-tts',
  google: 'google',
};

const ENGINES: { value: TtsEngine; label: string }[] = [
  { value: 'kokoro', label: 'Kokoro (local)' },
  { value: 'edge', label: 'Edge-TTS' },
  { value: 'google', label: 'Google Cloud TTS (chave)' },
];

function genderLabel(gender: string): string {
  return gender === 'female' ? 'feminina' : gender === 'male' ? 'masculina' : '';
}

export default function StepVoice(props: Props) {
  const { language, ttsEngine, setTtsEngine, voice, setVoice, rate, setRate } = props;

  const voices = voicesForLanguage(language);
  const provider: TtsProvider = PROVIDER_OF_ENGINE[ttsEngine];
  const providerVoices = voices.filter((v) => v.provider === provider);
  const shown = providerVoices.length > 0 ? providerVoices : voices;

  const pickEngine = (engine: TtsEngine) => {
    setTtsEngine(engine);
    // Ao mudar de motor, escolher a primeira voz desse motor no idioma;
    // se o motor não tiver voz no idioma, voltar à omissão do idioma.
    const p: TtsProvider = PROVIDER_OF_ENGINE[engine];
    const first = voices.find((v) => v.provider === p);
    if (first) {
      setVoice(first.voice);
    } else {
      const def = defaultVoiceFor(language);
      setVoice(def.voice);
      setTtsEngine(ENGINE_OF_PROVIDER[def.provider]);
    }
  };

  return (
    <div className="card">
      <h2>Voz</h2>
      <p className="muted">
        Motor de texto-para-fala e voz da narração — vozes do catálogo para o
        idioma escolhido. O áudio real é gerado na Fase 2.
      </p>

      <div className="field">
        <span className="label">Motor de TTS</span>
        <div className="radio-group">
          {ENGINES.map((e) => (
            <label className="radio" key={e.value}>
              <input
                type="radio"
                name="tts-engine"
                checked={ttsEngine === e.value}
                onChange={() => pickEngine(e.value)}
              />
              {e.label}
            </label>
          ))}
        </div>
      </div>

      <div className="field">
        <label htmlFor="voice">Voz</label>
        <select
          id="voice"
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
        >
          {shown.map((v) => (
            <option key={`${v.provider}:${v.voice}`} value={v.voice}>
              {v.voice} — {providerLabel(v.provider)}
              {genderLabel(v.gender) ? `, voz ${genderLabel(v.gender)}` : ''}
              {v.verified ? '' : ' (por verificar)'}
            </option>
          ))}
        </select>
        <p className="hint">
          {shown.some((v) => !v.verified)
            ? 'Vozes marcadas "(por verificar)" têm nomes da lista pública do provider — confirma no teu PC antes de usar.'
            : 'Todas as vozes listadas têm nomes confirmados.'}
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
