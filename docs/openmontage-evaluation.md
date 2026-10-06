# Avaliação do OpenMontage — ideias para o shorts-forge

> Documento de avaliação (não implementação). Língua: pt-PT.
> Data: 2026-10-05. Contexto: `ARCHITECTURE.md` e `ROADMAP.md` do shorts-forge.

## 1. O que é o OpenMontage (um parágrafo)

O **OpenMontage** (github.com/calesthio/OpenMontage, ~29 mil estrelas) é um
sistema *open-source* de produção de vídeo "agêntico": em vez de ter um
orquestrador oculto, o assistente de programação do utilizador (Claude Code,
Cursor, Copilot, Codex, …) atua como realizador, lendo **manifestos de
pipeline em YAML** e ficheiros Markdown de "skills" e executando a produção
diretamente. Oferece 11–12 pipelines declarativos (explainer animado,
trailer cinematográfico, montagem documental a partir de arquivos abertos,
fábrica de clips, …), ferramentas livres por defeito (narração offline,
arquivo Archive.org/NASA/Wikimedia, stock Pexels/Unsplash/Pixabay,
composição Remotion/HyperFrames, FFmpeg, legendas com word timing) e uma
filosofia de **gates de qualidade**: checkpoints com aprovação humana,
validação antes da composição e **self-review automática após cada
render**. Filosoficamente, é uma arquitetura de *conjunto de instruções
declarativas* em vez de um motor de código fechado.

## 2. Aviso de licença — AGPL-3.0 (crítico)

O OpenMontage está licenciado sob **AGPL-3.0**. Consequências práticas
para o shorts-forge:

- **Ideias e conceitos apenas.** Ideias não são protegidas por direitos
  de autor; a sua *expressão* (código, textos das skills, manifests) é.
- **NUNCA copiar código**, blocos de código, textos de skills/docs ou
  ficheiros fonte — nem adaptar "com pequenas alterações".
- Incorporar qualquer parte do código OpenMontage obrigaria a licenciar
  o trabalho resultante como um todo sob a AGPL (§5(c)).
- Tudo o que é proposto neste documento foi reconstruído a partir de
  descrições públicas de alto nível e de técnicas standard (uso genérico
  de FFmpeg/ffprobe), sem reproduzir material do projeto.

## 3. Avaliação das ideias

Legenda dos veredictos: **ADOTAR** (tal como é, cabe na nossa arquitetura),
**ADAPTAR** (o conceito é bom, mas precisa de forma própria para o
shorts-forge), **REJEITAR** (não cabe — com motivos).

### a. Manifestos YAML declarativos por pipeline

**Veredicto: ADAPTAR.**

O conceito no OpenMontage é duplo: (1) cada *tipo* de pipeline é descrito
por um manifesto YAML (etapas, gates de aprovação, focos de revisão); (2)
a produção concreta é rastreada por checkpoints. No shorts-forge, a peça
(1) **não se aplica**: temos um único pipeline determinístico
(especificado em `ARCHITECTURE.md` §2–§4), não uma família de pipelines
agênticos — um motor genérico de manifests duplicaria a nossa máquina de
estados de `Job` sem benefício. E a peça (2) já existe em espírito: a
**Spec é o nosso manifesto declarativo** (JSON validado por schema +
regras, revisão humana obrigatória antes da Fase B).

O que vale a pena aproveitar, adaptado, é o manifesto **por projeto** —
um ficheiro declarativo, legível por humanos, que congela tudo o que
definiu um vídeo concreto, para reprodutibilidade e auditoria (a nossa
versão do "checkpoint"). Isto liga-se diretamente à ideia (c).

**Proposta concreta (adaptada): `project.yaml`**
Gerado automaticamente pelo `pipeline` quando o job passa a `done`,
guardado na pasta do projeto (ver §4.3):

```yaml
project: 3-habitos-manha
format: "9:16"
language: pt-PT
createdAt: 2026-10-05T21:40:00+01:00
input: { kind: topic, topic: "3 hábitos que mudam as tuas manhãs" }
specRef: spec.json            # a Spec aprovada, integral
settings:
  breathMarginSec: 0.25
  tts: { provider: kokoro, voice: "pt-PT-voice-1" }
  broll: { providers: [pexels, image-fallback, generated] }
segments:
  - id: seg-01
    narration: "Acordas, pegas no telemóvel…"
    actualDurationSec: 5.42
    assets:
      audio: segments/seg-01/audio.wav
      broll: segments/seg-01/broll.mp4   # ou imagem + kenburns
    approvedBy: user
    approvedAt: 2026-10-05T21:47:00+01:00
render:
  final: renders/final.mp4
  preview: renders/preview.mp4
  qc: { status: pass, report: qc-report.json }
```

**Motivo do ADAPTAR em vez de ADOTAR:** adotar manifests "tal como no
OpenMontage" significaria introduzir um motor declarativo de etapas, que
conflita com o nosso desenho deliberado de pipeline determinístico em
duas fases com contratos TypeScript (`shared`). O valor real está no
**registo declarativo por projeto**, não num motor de pipelines.

**Fase de roadmap sugerida:** Fase 6 (pós-produto), junto com a library
(ver c). Esforço pequeno se feito depois da persistência de jobs.

### b. Revisão de qualidade automática após o render (QC)

**Veredicto: ADOTAR.**

É a ideia de maior retorno por esforço. O nosso pipeline de duas fases
elimina o *drift* guião↔áudio, mas **nada verifica o artefacto final**:
um render pode sair silenciosamente estragado (faixa de áudio em falta,
frames pretos, legendas ausentes, duração errada) e hoje só a Joana o
detetaria a olho. O OpenMontage corre, após cada render, validação com
ffprobe, extração de frames para detetar frames pretos/overlays partidos,
análise de níveis de áudio (silêncio, clipping) e verificação de legendas
— se falhar, o vídeo não é apresentado. Tudo isto é **local, grátis e
determinístico**, 100% compatível com a política free-only.

**Proposta concreta: etapa `qc` na Fase B**, entre `render()` e a
transição para `done`. Novo estado de job: `qc-failed` (com relatório),
que bloqueia o download até correção ou aprovação manual explícita
("apresentar mesmo assim"). Checklist (todas verificáveis com
FFmpeg/ffprobe, sem dependências novas):

| # | Verificação | Técnica | Critério de falha |
|---|---|---|---|
| 1 | Duração total | ffprobe: duração do MP4 vs soma de `actualDurationSec` | desvio > 0,5 s |
| 2 | Streams presentes | ffprobe: vídeo + áudio | áudio em falta |
| 3 | Resolução/formato | ffprobe: largura×altura vs `format` (9:16 → 1080×1920) | mismatch |
| 4 | Frames pretos | extração de frames em 4 posições (início, ⅓, ⅔, fim) + `blackdetect` | frame totalmente preto ou segmento preto > 1 s |
| 5 | Silêncio no áudio | `silencedetect` | silêncio contínuo > 2 s |
| 6 | Clipping/distorção | `astats` / `volumedetect` | pico a 0 dBFS sustentado |
| 7 | Legendas presentes | contagem de eventos de legenda queimados na timeline (a partir de `words[]`) | 0 eventos num vídeo com narração |
| 8 | B-roll resolvido | todos os segmentos com `broll` preenchido e ficheiro existente em disco | asset em falta |
| 9 | Integridade do ficheiro | ffprobe sem erros de descodificação | erros de stream |

Resultado: `qc-report.json` por render (check → pass/fail + detalhe), e
uma **validação pré-render** mínima (bloquear o render se algum segmento
não tiver `tts`+`broll`+`actualDurationSec` ou asset em falta — hoje isto
é regra de validação da Spec; o QC pré-render torna-a executável).

**Motivo do ADOTAR:** encaixa exatamente no buraco da nossa arquitetura
(verificamos o plano, não o produto), custo quase zero (FFmpeg já é
dependência), e reforça o princípio "medir, não estimar" — agora aplicado
também ao artefacto final.

**Fase de roadmap sugerida:** Fase 4 (Montagem), como último passo do
`video.render()` / `pipeline.render()` — o "Done" da Fase 4 passa a
incluir "QC automático passa no MP4 final".

### c. Conceito de "library" (catálogo persistente de projetos)

**Veredicto: ADOTAR (forma própria, âmbito contido).**

No OpenMontage, cada produção cria `projects/<nome>/` (`artifacts/`,
`assets/`, `renders/`) e um comando "backlot" abre a biblioteca de todos
os projetos em disco — um storyboard vivo. No shorts-forge, os `Job`
vivem hoje em memória: sem histórico, sem re-download, sem reutilização
de assets (ex. B-roll já descarregado, TTS já gerado). Para os objetivos
"poucos cliques" e local-first, uma library é o passo natural de produto:
a Joana abre a UI e vê os seus vídeos, não um formulário vazio.

**Proposta concreta (adaptada ao nosso âmbito):**

- **No disco:** `projects/<slug>/`
  ```
  projects/3-habitos-manha/
    project.yaml        # manifesto do §3a
    spec.json           # Spec aprovada (Fase A)
    input/              # áudio original (se kind=audio)
    segments/seg-01/{audio.wav, words.json, broll.mp4}
    renders/{preview.mp4, final.mp4}
    qc-report.json
    thumb.jpg           # frame do meio, para a grelha da UI
  ```
- **Índice:** SQLite local (`projects/library.db`, via `better-sqlite3`
  ou similar — grátis, sem servidor) com uma tabela `projects`
  (campos abaixo). JSON por projeto chega para começar; o SQLite
  justifica-se quando a pesquisa/filtros crescerem. Começar por JSON
  (`projects/index.json`) e migrar para SQLite só se preciso — decisão
  de implementação na altura.
- **Modelo de dados (mínimo):** `id/slug`, `title`, `format`, `language`,
  `inputKind`, `status` (mapeia `JobStatus` + `qc-failed`),
  `createdAt`, `durationSec`, `renderPath`, `thumbPath`, `qcStatus`,
  `specRef`. Nada de utilizadores, permissões ou sincronização — é
  single-user local.
- **Na UI:** 5.º ecrã (ou separador inicial) "Os meus vídeos": grelha
  com thumbnails, download, duplicar ("nova versão a partir deste"),
  apagar (para a reciclagem). Reutilização de assets: ao duplicar, o
  TTS/B-roll já resolvidos são reaproveitados (poupa minutos e evita
  re-downloads).

**Âmbito a NÃO copiar:** o "backlot" como storyboard vivo com boards por
etapa e simulações — isso serve um fluxo agêntico multi-etapa; para nós,
um catálogo simples chega. Manter a library **contida** é o que a
distingue de virar um CMS.

**Motivo do ADOTAR:** resolve uma lacuna real de produto (persistência),
é local e grátis, e é pré-requisito para o `project.yaml` do §3a.

**Fase de roadmap sugerida:** Fase 6 (nova, "Produto II"), após a Fase 5
— a Fase 5 entrega "do zero ao primeiro vídeo"; a library entrega "do
primeiro aos próximos cinquenta".

### d. Outras ideias fortes encontradas

1. **Criação a partir de referência** (colar um Short/Reel de exemplo →
   o agente transcreve, analisa ritmo e estilo visual, propõe variantes).
   **ADAPTAR (mais tarde).** O conceito encaixa no nosso público (fazer
   shorts "como aquele"), mas a análise de estilo visual é multimodal e
   pesada. Versão adaptada e exequível: "modo inspiração" em que a Joana
   cola um URL/transcrição e o pipeline extrai **ritmo** (duração média
   de frase, nº de segmentos) e **ganchos** (primeiras frases) para
   alimentar o prompt da Fase A — sem visão computacional. Fase 7+,
   opcional.

2. **Pesquisa semântica de B-roll (embeddings CLIP)** em vez de só
   palavras-chave — o OpenMontage pesquisa por significado no seu corpus.
   **ADAPTAR (mais tarde).** Para nós: indexar por embeddings apenas o
   **cache local** de B-roll (`outputs/cache/broll/`), com um modelo
   CLIP pequeno descarregado pelo `doctor`. Melhora a reutilização sem
   chaves nem custo. Fase 6+, estritamente opcional e desligável.

3. **Perfis de saída por plataforma** (resolução/bitrate por TikTok,
   YouTube, Instagram…). **ADOTAR (pequeno).** Hoje só distinguimos
   9:16/16:9. Um mapa de presets de codificação FFmpeg por plataforma
   (ex. 1080×1920, bitrate-alvo) é trivial, grátis e reduz fricção de
   publicação. Cabe na Fase 4 como opção no `RenderOptions`.

4. **"Slideshow risk scoring"** (deteção de "PowerPoint animado").
   **REJEITAR.** É uma heurística editorial para fluxos agênticos com
   dezenas de decisões visuais autónomas; o nosso pipeline tem decisões
   visuais determinísticas (templates + B-roll com regras de montagem) e
   revisão humana da Spec. Complexidade sem problema correspondente.

5. **Protocolo de reviewer agêntico** (self-review após cada etapa, máx.
   2 rondas, severidades critical/suggestion/nitpick). **REJEITAR como
   mecanismo; ADOTAR o espírito.** O nosso LLM só escreve a Spec — já
   temos validação estrita + gate humano, que é mais forte. O que se
   aproveita: registar **decisões e aprovações** no `project.yaml`
   (audit trail mínimo), já proposto em (a)/(c).

6. **Governança de custos** (mostrar custo antes de chamadas pagas).
   **REJEITAR (não aplicável).** A nossa política free-only torna-o
   desnecessário: o equivalente já existe no desenho (`GET
   /api/llm/status` mostra estado dos providers na UI).

## 4. Resumo dos veredictos

| Ideia | Veredicto | Fase sugerida |
|---|---|---|
| a. Manifestos YAML declarativos | **ADAPTAR** → `project.yaml` por projeto (registo/auditoria, não motor de etapas) | Fase 6 |
| b. QC automático pós-render | **ADOTAR** → etapa `qc` na Fase B + estado `qc-failed` | Fase 4 |
| c. Library de projetos | **ADOTAR** → `projects/<slug>/` + índice local + ecrã "Os meus vídeos" | Fase 6 |
| d1. Criação a partir de referência | ADAPTAR (modo inspiração só com ritmo/ganchos) | Fase 7+ |
| d2. B-roll por embeddings CLIP | ADAPTAR (só sobre o cache local, opcional) | Fase 6+ |
| d3. Presets por plataforma | ADOTAR (mapa de presets FFmpeg) | Fase 4 |
| d4. Slideshow risk scoring | REJEITAR | — |
| d5. Reviewer agêntico | REJEITAR mecanismo / adotar audit trail | (coberto em a/c) |
| d6. Governança de custos | REJEITAR (não aplicável, free-only) | — |

## 5. Recomendação principal

**Implementar primeiro o QC automático pós-render (b), na Fase 4.**
É a única ideia que tapa um buraco real e atual da arquitetura —
verificamos exaustivamente o *plano* (Spec validada + gate humano) mas
nada verifica o *produto*. Custa apenas trabalho com ferramentas que já
são dependências (FFmpeg/ffprobe), é 100% local e gratuita, e cada vídeo
mau apanhado antes de chegar à Joana paga o investimento. Em segundo
lugar, a **library (c) + `project.yaml` (a)** como Fase 6, que transforma
o shorts-forge de "ferramenta de um vídeo" em "estúdio pessoal".
