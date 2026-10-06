import type { InputTab } from '../state';
import { supportedLanguages } from '../lib/voices';

interface Props {
  inputTab: InputTab;
  setInputTab: (tab: InputTab) => void;
  audioFileName: string | null;
  setAudioFileName: (name: string | null) => void;
  topic: string;
  setTopic: (topic: string) => void;
  language: string;
  setLanguage: (language: string) => void;
}

export default function StepInput(props: Props) {
  const { inputTab, setInputTab, audioFileName, setAudioFileName, topic, setTopic, language, setLanguage } = props;

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setAudioFileName(file ? file.name : null);
  };

  return (
    <div className="card">
      <h2>Entrada</h2>
      <p className="muted">
        Escolhe a origem do vídeo: uma gravação tua (transcrevemos o áudio) ou um tema
        (o LLM escreve o guião do zero).
      </p>

      <div className="tabs" role="tablist" aria-label="Origem">
        <button
          type="button"
          role="tab"
          aria-selected={inputTab === 'audio'}
          className={inputTab === 'audio' ? 'active' : ''}
          onClick={() => setInputTab('audio')}
        >
          Ficheiro de áudio
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={inputTab === 'topic'}
          className={inputTab === 'topic' ? 'active' : ''}
          onClick={() => setInputTab('topic')}
        >
          Tema
        </button>
      </div>

      <div className="field">
        <label htmlFor="language">Idioma do vídeo</label>
        <select
          id="language"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          {supportedLanguages().map((l) => (
            <option key={l.tag} value={l.tag}>
              {l.label}
            </option>
          ))}
        </select>
        <p className="hint">
          {inputTab === 'audio'
            ? 'Usado como pista para a transcrição e para a voz da narração.'
            : 'O LLM escreve o guião neste idioma e a narração usa uma voz correspondente.'}
        </p>
      </div>

      {inputTab === 'audio' ? (
        <div className="field">
          <label className="file-picker">
            Escolher ficheiro de áudio
            <input type="file" accept="audio/*" onChange={onFileChange} />
          </label>
          {audioFileName ? (
            <p className="file-name">
              Selecionado: <strong>{audioFileName}</strong>
            </p>
          ) : (
            <p className="muted">Nenhum ficheiro selecionado.</p>
          )}
          <p className="hint">
            Na Fase 2, o áudio é transcrito localmente (faster-whisper) e o guião é
            escrito a partir da transcrição.
          </p>
        </div>
      ) : (
        <div className="field">
          <label htmlFor="topic">Tema do vídeo</label>
          <textarea
            id="topic"
            rows={4}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Ex.: 3 hábitos que mudam as tuas manhãs"
          />
        </div>
      )}
    </div>
  );
}
