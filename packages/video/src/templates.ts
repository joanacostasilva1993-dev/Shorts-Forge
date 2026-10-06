/**
 * Brand templates for shorts-forge videos.
 *
 * A BrandTemplate is pure data: colors, font stack and caption geometry.
 * Renderers (Hyperframes composition builder, preview page) consume it;
 * no template ever invents timing — karaoke timing always comes from real
 * TTS word timestamps (see captions.ts).
 */

/**
 * Where captions sit inside the frame.
 *
 * NOTE: the position is interpreted INSIDE the platform preset's safe
 * area (see `captionBoxFor` in captions.ts and `presets.ts`): renderers
 * clamp the caption box so text never runs under platform UI overlays
 * (action rails, progress bars). Templates only declare the preference;
 * presets decide the margins.
 */
export type CaptionPosition = 'center' | 'lower-third';

export interface BrandTemplate {
  /** Machine id, e.g. 'bold-social'. */
  id: string;
  /** Display name (pt-PT). */
  name: string;
  /** Short description (pt-PT). */
  description: string;
  colors: {
    /** Page/scene background. */
    bg: string;
    /** Primary text color. */
    fg: string;
    /** Accent used for decorations, progress bars, hook text. */
    accent: string;
    /** Color of the currently-spoken (karaoke) word. */
    highlight: string;
  };
  /** CSS font-family stack. */
  fontStack: string;
  caption: {
    /** Caption font size in px at 1080px-wide reference canvas. */
    fontSizePx: number;
    /** Outline stroke width in px (0 = none). */
    strokePx: number;
    position: CaptionPosition;
  };
}

const TEMPLATES: Record<string, BrandTemplate> = {
  'bold-social': {
    id: 'bold-social',
    name: 'Social Intenso',
    description:
      'Tipografia pesada com contorno de alto contraste e acentos vibrantes. Ideal para captar atenção nos primeiros segundos.',
    colors: {
      bg: '#0a0a12',
      fg: '#ffffff',
      accent: '#ff2e88',
      highlight: '#ffe14d',
    },
    fontStack: `'Archivo Black', 'Arial Black', 'Helvetica Neue', Helvetica, Arial, sans-serif`,
    caption: { fontSizePx: 68, strokePx: 3, position: 'center' },
  },
  minimal: {
    id: 'minimal',
    name: 'Minimalista',
    description:
      'Tipografia limpa sem contorno e legendas discretas no terço inferior. Ideal para conteúdo calmo e informativo.',
    colors: {
      bg: '#101010',
      fg: '#f5f5f5',
      accent: '#9a9a9a',
      highlight: '#ffffff',
    },
    fontStack: `'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif`,
    caption: { fontSizePx: 42, strokePx: 0, position: 'lower-third' },
  },
  cinematic: {
    id: 'cinematic',
    name: 'Cinematográfico',
    description:
      'Tipografia com serifa elegante e legendas suaves no terço inferior, pensada para vídeo com barras de cinema.',
    colors: {
      bg: '#000000',
      fg: '#f3ead7',
      accent: '#c9a227',
      highlight: '#ffd97a',
    },
    fontStack: `'Playfair Display', Georgia, 'Times New Roman', serif`,
    caption: { fontSizePx: 46, strokePx: 0, position: 'lower-third' },
  },
};

/** All available template ids. */
export function listTemplateIds(): string[] {
  return Object.keys(TEMPLATES);
}

/**
 * Returns the brand template for `id`.
 * @throws Error when the id is unknown.
 */
export function getTemplate(id: string): BrandTemplate {
  const t = TEMPLATES[id];
  if (!t) {
    throw new Error(
      `Modelo desconhecido: "${id}". Modelos disponíveis: ${listTemplateIds().join(', ')}.`,
    );
  }
  return t;
}
