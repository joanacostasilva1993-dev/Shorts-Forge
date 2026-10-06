# shorts-forge

Gera vídeos curtos verticais (9:16) ou vídeos longos (16:9) a partir de um
ficheiro de áudio ou de um tema — tudo localmente, no teu PC, com poucos
cliques.

## Como funciona (resumo)

1. **Dás o ponto de partida** — envias um áudio teu (uma gravação, um podcast,
   uma ideia) ou escreves um tema.
2. **A IA escreve o plano** — um modelo de linguagem cria a *Spec*: um guião
   plano-a-plano com durações, narração e palavras-chave visuais.
3. **A voz é gerada localmente** — o TTS (Kokoro, local) narra cada segmento e
   cada plano é **re-temporizado** com os tempos reais de cada palavra, por
   isso o vídeo nunca fica dessincronizado do áudio.
4. **O vídeo é montado** — os planos são renderizados com HTML/CSS (Hyperframes),
   legendas palavra a palavra, B-roll e montagem final com FFmpeg.

Detalhes completos em [ARCHITECTURE.md](./ARCHITECTURE.md) e o plano de
trabalho em [ROADMAP.md](./ROADMAP.md).

## Política free-only

**Nenhuma API paga é necessária — nunca.** Todo o pipeline funciona com
modelos gratuitos ou locais:

| Função | Solução gratuita/local |
|---|---|
| Modelos de linguagem | Router com failover: Gemini, Groq, OpenRouter `:free`, Mistral, Cerebras, GitHub Models, Pollinations (sem chave) → backstop local Ollama → modo browser WebLLM |
| Transcrição | faster-whisper (local, Python) |
| Voz (TTS) | Kokoro (local, Python) |
| Render de frames | Hyperframes (HTML/CSS → timeline MP4) |
| Montagem final | FFmpeg |

Chaves opcionais (Pexels/Pixabay para B-roll) são isso mesmo — *opcionais*.
Sem elas, o pipeline usa imagens locais. Ver `docs/` e `ARCHITECTURE.md`
para a estratégia de B-roll.

## Quickstart (esboço — em construção)

```bash
# 1. Clonar e instalar dependências
git clone <repo-do-github> shorts-forge
cd shorts-forge
npm install

# 2. Diagnóstico do ambiente (FFmpeg, Python, modelos, Ollama…)
npm run doctor

# 3. Sacar os modelos locais (whisper + kokoro)
npm run models:download

# 4. Arrancar a interface web local
npm run dev
# → abre http://localhost:3000
```

A UI guia-te em 4 passos: **origem** (áudio ou tema) → **guião** (revês e
editas a Spec) → **pré-visualização** → **render final**.

## API do pipeline (Fase 2)

O orquestrador expõe a API REST do contrato congelado (`ARCHITECTURE.md`
§8) em **`http://localhost:3000/api`** — é aí que a UI (e futuros CLIs)
criam jobs, geram a Spec, subscrevem o progresso (SSE) e lançam o render.

```bash
# Arrancar a API (compila e serve em http://localhost:3000/api)
npm run dev:pipeline

# Verificar que está viva:
curl http://localhost:3000/api/llm/status
```

A porta é `PIPELINE_API_PORT` (omissão `3000` — o contrato congelado; ver
`.env.example`). Os serviços Python de transcrição (`:8001`) e TTS (`:8002`)
arrancam **por preguiça** no primeiro job que precisar deles; se estiverem
em baixo, os erros dizem exatamente o que fazer (em pt-PT).

**Estado da Fase 2:** o ciclo tema → Spec → TTS produz `segments[].tts`
com durações reais e a Spec re-temporizada. A montagem do MP4 final é Fase 4
— o `/download` responde 409 honesto até lá.

## Fase 2 — pôr a funcionar

```bash
# 1. Instalar dependências (Node + serviços Python)
npm install
python3 -m venv packages/tts/service/.venv
packages/tts/service/.venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
packages/tts/service/.venv/bin/pip install -r packages/tts/service/requirements.txt
# (o serviço de transcrição usa faster-whisper; instala-o no Python que
#  corre packages/transcription/service/server.py)

# 2. Sacar os modelos locais (whisper + Kokoro; ~800 MB no total)
npm run models:download

# 3. Arrancar os serviços Python (cada um no seu terminal)
python3 packages/transcription/service/server.py   # :8001
(cd packages/tts/service && .venv/bin/python app.py)   # :8002

# 4. Arrancar a API do pipeline (:3000 — a UI e a API partilham a porta)
npm run dev:pipeline

# 5. Verificar que está tudo bem
npm run doctor
```

Do que precisas:

- **Nada de chaves para o básico.** Transcrição (faster-whisper), voz
  (Kokoro) e B-roll de recurso funcionam 100% locais, sem conta nem
  internet (depois dos modelos sacados).
- **Google Cloud TTS é opcional.** Só precisas de credenciais
  (`GOOGLE_TTS_API_KEY` ou `GOOGLE_APPLICATION_CREDENTIALS` no `.env`) se
  quiseres esse provider; sem elas, o pipeline usa Kokoro/Edge-TTS sem
  falhar. Ativa a Cloud Text-to-Speech API no teu projeto Google.
- **LLMs:** sem chaves, o router usa Pollinations (sem chave) → Ollama
  local. Com chaves gratuitas no `.env` (`GEMINI_API_KEY`, `GROQ_API_KEY`,
  …), gasta primeiro as quotas renováveis. Para gerar a Spec na Fase A
  precisas de pelo menos um provider alcançável (ou Ollama a correr).
- **Vozes:** confirma `KOKORO_VOICE` no `.env` depois de ouvires as
  amostras — a naturalidade do pt-PT é o risco nº 1 (ver `TEST_PLAN.md`
  §11).

## Estrutura do monorepo

```
shorts-forge/
├── packages/
│   ├── shared/          # Tipos TypeScript canónicos (@shorts-forge/shared)
│   ├── llm-router/      # Router de LLMs com failover (em construção)
│   ├── pipeline/       # Orquestrador do pipeline em duas fases
│   ├── transcription/  # Serviço faster-whisper (Python)
│   ├── tts/            # Serviço Kokoro (Python)
│   ├── video/          # Templates Hyperframes + montagem FFmpeg
│   └── ui/             # Interface web local
├── ARCHITECTURE.md      # Arquitetura detalhada
├── ROADMAP.md           # Fases de desenvolvimento
├── LICENSE              # GNU AGPL-3.0 (texto completo)
└── docs/                # Notas de decisão (providers TTS, B-roll, avaliações)
```

## Desenvolvimento

```bash
npm run build      # compila todos os workspaces
npm run typecheck  # verificação de tipos
npm run test       # testes
```

Regras de código: identificadores em **inglês**; documentação e textos
visíveis ao utilizador em **português europeu (pt-PT)**.

## Licença

Este projecto é software livre, distribuído sob a
**GNU Affero General Public License v3.0 (AGPL-3.0)** — ver o ficheiro
[LICENSE](./LICENSE) com o texto completo.

Na prática: podes usar, estudar, modificar e partilhar o código à vontade.
Se disponibilizares uma versão modificada como serviço em rede, tens de
disponibilizar também o código-fonte correspondente (é a cláusula Affero).

Notas de compatibilidade:

- Dependências via npm como o Hyperframes (Apache 2.0) são compatíveis com
  a AGPL-3.0 — usá-las como dependência não é problema.
- Aproveitamos **ideias e conceitos** de outros projectos; nunca copiamos
  código deles. Se algum dia for preciso reutilizar código MIT/Apache-2.0,
  a origem é documentada e a compatibilidade verificada antes.
