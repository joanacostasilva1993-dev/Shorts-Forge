/**
 * Dados de exemplo para o esqueleto da Fase 5.
 *
 * A UI ainda não fala com o backend, por isso as 3 portas de revisão
 * usam estes 2 segmentos gerados em código. Estão claramente marcados
 * na interface como "dados de exemplo (simulação)" — nada finge ser real.
 */

import type { Segment, Spec, VideoFormat } from '@shorts-forge/shared';

export const SAMPLE_DATA_LABEL = 'dados de exemplo (simulação)';

/** Gera 2 segmentos de exemplo a partir do tema escolhido. */
export function generateMockSpec(
  topic: string,
  format: VideoFormat,
): Spec {
  const title = topic.trim() || 'Vídeo de exemplo';
  const segments: Segment[] = [
    {
      id: 'seg-01',
      narration:
        'Isto muda tudo na forma como começas o teu dia. ' +
        'Nos próximos segundos vais perceber porquê.',
      visualKeywords: ['despertador', 'manhã', 'cama'],
      brollDescription: 'Mão a desligar um despertador de manhã cedo, luz suave',
      targetDurationSec: 5.0,
      hookScore: 0.95,
      hookLine: 'Larga o telemóvel',
    },
    {
      id: 'seg-02',
      narration:
        'Primeiro hábito: luz natural nos primeiros dez minutos. ' +
        'Diz ao teu cérebro que o dia começou.',
      visualKeywords: ['janela', 'luz do sol', 'café da manhã'],
      brollDescription: 'Pessoa a abrir a janela com sol da manhã a entrar',
      targetDurationSec: 6.5,
      hookScore: 0.62,
      hookLine: 'Hábito nº 1: luz natural',
    },
  ];
  return {
    version: 1,
    title,
    format,
    language: 'pt-PT',
    segments,
  };
}

/** Simulação da "regeneração" de um segmento (mock visível). */
export function mockRegenerateSegment(segment: Segment): Segment {
  return {
    ...segment,
    narration: `${segment.narration} (rev. 2)`,
  };
}
