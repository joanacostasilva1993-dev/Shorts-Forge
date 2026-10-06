# B-roll — resolução, pontuação e clips curtos

> Estado: Fase 4 (afinação semântica). Implementação:
> `packages/video/src/broll.ts`; testes
> `packages/video/src/test/broll.test.ts`.
> Identificadores de código em inglês; este documento em pt-PT.

## 1. A cascata (nunca vazia)

Para cada segmento, por ordem:

1. **Pexels** (tier gratuito; precisa de `PEXELS_API_KEY`) — pesquisa
   multi-query (§3), escolhe o melhor candidato não usado.
2. **Pixabay** (tier gratuito; precisa de `PIXABAY_API_KEY`) — idem.
3. **Ken Burns** — zoom/pan lento sobre um gradiente, gerado localmente
   com FFmpeg; sem chaves, sem rede.
4. **Template** — gradiente estático gerado com FFmpeg; sem FFmpeg, a
   entrada fica com `url: ''` e o `buildFrames()` usa a cor do template.

Garantias que não mudam:

- **Nunca vazio**: `resolveBroll()` nunca lança por razões da cascata e
  devolve sempre uma entrada `broll` válida.
- **Sem repetição**: `UsedClipRegistry` por projeto
  (`outputs/<jobId>/broll-registry.json`) — um `clipId` nunca se repete
  no mesmo vídeo.
- **Download único**: `outputs/cache/broll/<clipId>.mp4`; ficheiro
  existente e não vazio nunca é descarregado de novo.
- **Fall-through silencioso**: erros de rede, HTTP 4xx/5xx e 429 são
  registados no `log` e a cascata continua — nunca quebram o render.
- **Zero chaves**: sem `PEXELS_API_KEY`/`PIXABAY_API_KEY` o fluxo
  continua em Ken Burns → template.

## 2. Pontuação de candidatos (scoring v2)

`scoreCandidate()` devolve `{ total, relevance, durationFit, orientation }`:

```
total = 0.55 × relevance + 0.35 × durationFit + 0.10 × orientation
```

### relevance (55%)

```
relevance = 0.70 × overlapPonderado(keywords expandidas, textoCandidato)
          + 0.30 × overlapPonderado(descrição expandida, textoCandidato)
```

Cada termo do segmento é expandido com pesos:

| Variante do termo | Peso |
|---|---|
| o termo exato | 1.0 |
| radical singular ingénuo (`cities`→`city`) | 0.9 |
| sinónimo/termo relacionado (mapa curado `SYNONYMS`) | 0.7 |

Cada termo pontua pelo **melhor** match contra o texto do candidato:
igualdade exata de token → 1.0; substring/prefixo em qualquer direção
→ 0.6; sem match → 0.0. O resultado é normalizado pela soma dos pesos
(em [0, 1]; 0.5 neutro quando não há termos).

O **texto do candidato** é a união de três sinais:

1. **tags do provider** — as tags próprias do Pixabay; no Pexels (que não
   devolve tags) usam-se os tokens da query que encontrou o clip;
2. **tokens do slug do URL da página** — ex.
   `pixabay.com/videos/sunrise-city-skyline-770/` → `sunrise, city,
   skyline` (ids numéricos descartados);
3. (implícito em 1) os tokens das várias queries da pesquisa multi-query
   são unidos quando o mesmo clip aparece em mais de uma variante.

Racional dos pesos: a relevância domina porque um clip errado-mas-ajustado
é pior que um clip certo-mas-curto (clips curtos são estendidos de forma
suave pelo fit de §4); a duração vem a seguir porque cortar é grátis e
estender custa um re-encode; a orientação é desempate (o render faz crop
na mesma).

### durationFit (35%)

- `dur >= needed`: `1 − 0.3 × min(1, (dur − needed) / needed)` —
  match exato pontua 1.0, decaindo até 0.7 a 2× a duração (cortar é
  barato, mas o excesso é desperdício);
- `dur < needed`: `0.75 × (dur / needed)` — clips curtos têm de ser
  estendidos, visivelmente pior que cortar.

### orientation (10%)

1.0 quando a orientação do clip condiz com o formato de saída;
0.0 no caso contrário (0.25 para clip portrait num vídeo 16:9, cujo crop
é aceitável).

## 3. Pesquisa multi-query

Por segmento disparam-se **2–3 variantes de query** (sequencialmente,
para ser gentil com as quotas gratuitas; as variantes secundárias pedem
menos resultados):

1. **primária**: até 3 `visualKeywords` (ex. `sunrise city timelapse`);
2. **sinónimos**: cada keyword trocada pelo seu primeiro sinónimo
   (ex. `dawn urban hyperlapse`);
3. **descritiva**: primeiros tokens de `brollDescription`
   (ex. `timelapse sunrise city skyline` — outro ângulo sobre o plano).

Os candidatos das variantes são **fundidos e desduplicados por `clipId`**
(tags unidas), e só depois pontuados. Semântica de falha: se a **primeira**
variante falhar, o erro propaga (a cascata cai para o provider seguinte —
erros de autenticação têm de falhar depressa); se uma variante **tardia**
falhar (ex. 429 a meio), ficam os candidatos já recolhidos — degrada o
recall, nunca o provider inteiro.

Nota: `visualKeywords` do LLM vêm **sempre em inglês** (ARCHITECTURE.md
§2), por isso o mapa de sinónimos é um único mapa inglês, curado e
orientado a vídeo (termos que as bibliotecas stock realmente usam como
tags) — um thesaurus completo traria mais ruído que sinal.

## 4. Clips mais curtos que o segmento — decisão resolvida

> **Decisão (era a decisão em aberto do ARCHITECTURE.md §7): clip mais
> curto que o segmento → loop suave com crossfade, por omissão.**

Quando um clip stock fica aquém da duração do segmento, o resolvedor
estende-o com FFmpeg **antes** do render:

- **`'loop'` (omissão)** — o clip é repetido N vezes e as junções levam
  crossfade (`xfade`, fade = min(0.5s, duração/4)), com trim exato à
  duração do segmento. O ponto de loop fica invisível.
- **`'freeze'`** — o clip passa uma vez e o **último frame é congelado**
  (`tpad=stop_mode=clone`) pelo tempo em falta.

Nunca se estica no tempo (`setpts`) — cria artefactos visíveis.

### Configuração por projeto

`shortClipStrategy: 'loop' | 'freeze'` (tipo canónico em
`@shorts-forge/shared`):

- `POST /api/jobs { …, "shortClipStrategy": "freeze" }` → guardado no
  `Job` → a Fase B passa-o a `resolveBrollForSegments()` →
  `ResolveBrollOptions.shortClipStrategy`;
- ausente → omissão `'loop'`;
- valor inválido → `400 invalid_input` (mensagem em pt-PT).

**Reversível**: o clip original fica intacto na cache; o clip estendido
é um derivado com nome determinístico
(`fit-<strategy>-<clipId>-<duração>s.mp4`, também em cache — sem
re-encode repetido). Voltar a resolver com a outra estratégia produz
outro ficheiro; nada é destruído. A estratégia aplicada fica registada
em `segment.broll.shortClipStrategy` (só quando houve fit de verdade);
se o fit falhar (sem FFmpeg, clip degenerado), o clip curto original é
entregue com a duração honesta — a garantia "nunca vazio" mantém-se.

### Onde vive a opção e porquê

A opção vive na **resolução de B-roll** (`ResolveBrollOptions`, por
projeto via `Job`), não no render: é aí que se conhece o confronto
duração-do-clip × duração-do-segmento, e é aí que o FFmpeg já é usado
(Ken Burns). O `render.ts` não muda — recebe clips com a duração certa.
O tipo `ShortClipStrategy` vive em `@shorts-forge/shared` porque cruza
a fronteira REST (UI → API → pipeline → video), como `BrollProvider`.

## 5. Ficheiros e funções principais

| Peça | Onde |
|---|---|
| Cascata + registo + cache | `packages/video/src/broll.ts` |
| `scoreCandidate`, `selectBestCandidate` | idem (puros, testáveis) |
| `buildQueryVariants`, `searchPexelsMulti`, `searchPixabayMulti` | idem |
| `tokensFromPageUrl`, mapa `SYNONYMS` | idem |
| `buildSmoothLoopArgs`, `buildFreezeFrameArgs`, `fitShortClip` | idem (builders puros + execução real) |
| `ShortClipStrategy` | `packages/shared/src/index.ts` |
| `Job.shortClipStrategy`, `POST /api/jobs` | `packages/pipeline/src/{jobs,orchestrate,server}.ts` |
| Testes (45) | `packages/video/src/test/broll.test.ts` |
