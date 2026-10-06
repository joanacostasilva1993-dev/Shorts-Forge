import { useState } from 'react';
import type { Segment } from '@shorts-forge/shared';
import StepInput from './components/StepInput';
import StepVoice from './components/StepVoice';
import StepVisual from './components/StepVisual';
import StepFormat from './components/StepFormat';
import GateScript from './components/GateScript';
import GateStoryboard from './components/GateStoryboard';
import GateRender from './components/GateRender';
import { initialState, type AppState, type TtsEngine } from './state';
import { generateMockSpec } from './mock';
import { defaultVoiceFor } from './lib/voices';

const STEP_NAMES = ['Entrada', 'Voz', 'Modelo visual', 'Formato e geração'];

const ENGINE_OF_PROVIDER: Record<string, TtsEngine> = {
  kokoro: 'kokoro',
  'edge-tts': 'edge',
  google: 'google',
};

export default function App() {
  const [state, setState] = useState<AppState>(initialState);

  const patch = (p: Partial<AppState>) => setState((s) => ({ ...s, ...p }));

  /** Muda o idioma e repõe a voz omissa desse idioma. */
  const setLanguage = (language: string) => {
    const def = defaultVoiceFor(language);
    patch({
      language,
      ttsEngine: ENGINE_OF_PROVIDER[def.provider] ?? 'kokoro',
      voice: def.voice,
    });
  };

  const stepValid = (step: number): boolean => {
    if (step === 1) {
      return (
        (state.inputTab === 'topic' && state.topic.trim().length > 0) ||
        (state.inputTab === 'audio' && state.audioFileName !== null)
      );
    }
    return true;
  };

  const generate = () => {
    const spec = generateMockSpec(state.topic, state.format, state.language);
    patch({ phase: 'gate-script', spec });
    window.scrollTo(0, 0);
  };

  const restart = () => {
    setState(initialState);
    window.scrollTo(0, 0);
  };

  const updateSegments = (segments: Segment[]) => {
    patch({ spec: state.spec ? { ...state.spec, segments } : null });
  };

  const goGate = (phase: AppState['phase']) => {
    patch({ phase });
    window.scrollTo(0, 0);
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>shorts-forge</h1>
        <p className="muted">Gerador de vídeos por IA — esqueleto da interface</p>
      </header>

      {state.phase === 'wizard' ? (
        <>
          <ol className="steps" aria-label="Passos">
            {STEP_NAMES.map((name, i) => {
              const n = (i + 1) as AppState['step'];
              return (
                <li
                  key={name}
                  className={
                    state.step === n ? 'current' : state.step > n ? 'done' : ''
                  }
                  aria-current={state.step === n ? 'step' : undefined}
                >
                  <span className="step-num">{i + 1}</span> {name}
                </li>
              );
            })}
          </ol>

          {state.step === 1 && (
            <StepInput
              inputTab={state.inputTab}
              setInputTab={(inputTab) => patch({ inputTab })}
              audioFileName={state.audioFileName}
              setAudioFileName={(audioFileName) => patch({ audioFileName })}
              topic={state.topic}
              setTopic={(topic) => patch({ topic })}
              language={state.language}
              setLanguage={setLanguage}
            />
          )}
          {state.step === 2 && (
            <StepVoice
              language={state.language}
              ttsEngine={state.ttsEngine}
              setTtsEngine={(ttsEngine) => patch({ ttsEngine })}
              voice={state.voice}
              setVoice={(voice) => patch({ voice })}
              rate={state.rate}
              setRate={(rate) => patch({ rate })}
            />
          )}
          {state.step === 3 && (
            <StepVisual
              template={state.template}
              setTemplate={(template) => patch({ template })}
            />
          )}
          {state.step === 4 && (
            <StepFormat
              format={state.format}
              setFormat={(format) => patch({ format })}
              llmMode={state.llmMode}
              setLlmMode={(llmMode) => patch({ llmMode })}
              onGenerate={generate}
            />
          )}

          <div className="actions wizard-nav">
            {state.step > 1 && (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  patch({ step: (state.step - 1) as AppState['step'] })
                }
              >
                Anterior
              </button>
            )}
            {state.step < 4 && (
              <button
                type="button"
                className="btn primary"
                disabled={!stepValid(state.step)}
                onClick={() =>
                  patch({ step: (state.step + 1) as AppState['step'] })
                }
                title={
                  !stepValid(state.step)
                    ? 'Escolhe um ficheiro de áudio ou escreve um tema'
                    : undefined
                }
              >
                Seguinte
              </button>
            )}
          </div>
        </>
      ) : state.phase === 'gate-script' && state.spec ? (
        <GateScript
          segments={state.spec.segments}
          onChange={updateSegments}
          onContinue={() => goGate('gate-storyboard')}
          onBack={() => goGate('wizard')}
        />
      ) : state.phase === 'gate-storyboard' && state.spec ? (
        <GateStoryboard
          segments={state.spec.segments}
          onContinue={() => goGate('gate-render')}
          onBack={() => goGate('gate-script')}
        />
      ) : state.phase === 'gate-render' ? (
        <GateRender
          onRestart={restart}
          onBack={() => goGate('gate-storyboard')}
        />
      ) : null}

      <footer className="footer">
        <p className="muted">
          Esqueleto da Fase 5 — interface com dados de exemplo. O backend
          (pipeline, TTS, render) liga-se nas próximas fases.
        </p>
      </footer>
    </div>
  );
}
