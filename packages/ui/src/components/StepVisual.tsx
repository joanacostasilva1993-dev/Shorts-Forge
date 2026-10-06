import type { TemplateId } from '../state';

interface Props {
  template: TemplateId;
  setTemplate: (template: TemplateId) => void;
}

const TEMPLATES: {
  id: TemplateId;
  name: string;
  description: string;
}[] = [
  {
    id: 'intenso',
    name: 'Social Intenso',
    description: 'Cores fortes, tipografia grande — feito para captar atenção.',
  },
  {
    id: 'minimalista',
    name: 'Minimalista',
    description: 'Fundo claro, texto simples — tom calmo e direto.',
  },
  {
    id: 'cinematografico',
    name: 'Cinematográfico',
    description: 'Tons escuros, barras de cinema — ar mais sério.',
  },
];

export default function StepVisual({ template, setTemplate }: Props) {
  return (
    <div className="card">
      <h2>Modelo visual</h2>
      <p className="muted">
        Estilo dos planos do vídeo. Os templates reais (Hyperframes) chegam na
        Fase 3 — estas são pré-visualizações aproximadas em CSS.
      </p>

      <div className="template-grid">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`template-card${template === t.id ? ' selected' : ''}`}
            onClick={() => setTemplate(t.id)}
            aria-pressed={template === t.id}
          >
            <div className={`mini-preview mini-${t.id}`} aria-hidden="true">
              {t.id === 'cinematografico' ? (
                <>
                  <span className="bar top" />
                  <span className="hook-mini">O teu dia muda aqui</span>
                  <span className="bar bottom" />
                </>
              ) : (
                <span className="hook-mini">O teu dia muda aqui</span>
              )}
            </div>
            <div className="template-info">
              <strong>{t.name}</strong>
              <p>{t.description}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
