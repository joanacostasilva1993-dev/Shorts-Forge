import type { PlatformPresetId, Spec, VideoFormat } from '@shorts-forge/shared';

export type InputTab = 'audio' | 'topic';
export type TtsEngine = 'kokoro' | 'edge' | 'google';
export type TemplateId = 'intenso' | 'minimalista' | 'cinematografico';
export type LlmMode = 'cloud' | 'keyless' | 'browser';

export type Phase = 'wizard' | 'gate-script' | 'gate-storyboard' | 'gate-render';

export interface WizardState {
  step: 1 | 2 | 3 | 4;
  inputTab: InputTab;
  audioFileName: string | null;
  topic: string;
  /** Narration language tag (catálogo: pt-PT, pt-BR, en, fr). */
  language: string;
  ttsEngine: TtsEngine;
  voice: string;
  rate: number;
  template: TemplateId;
  format: VideoFormat;
  /** Platform preset chosen in step 4 (drives format, canvas and caption safe areas). */
  preset: PlatformPresetId;
  llmMode: LlmMode;
}

export interface AppState extends WizardState {
  phase: Phase;
  spec: Spec | null;
}

export const initialState: AppState = {
  phase: 'wizard',
  step: 1,
  inputTab: 'topic',
  audioFileName: null,
  topic: '',
  language: 'pt-PT',
  ttsEngine: 'edge',
  voice: 'pt-PT-DuarteNeural',
  rate: 1.0,
  template: 'intenso',
  format: '9:16',
  preset: 'youtube-shorts',
  llmMode: 'keyless',
  spec: null,
};
