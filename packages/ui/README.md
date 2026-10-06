# @shorts-forge/ui

Interface web local do **shorts-forge**: assistente de 4 passos (origem → voz →
modelo visual → formato) com 3 portas de revisão (guião → storyboard → render).

> **Esqueleto da Fase 5.** A UI corre com dados de exemplo e ainda não fala com
> o backend. Nada aqui finge fazer trabalho real: botões sem funcionalidade
> estão desativados e marcados com "em breve".

## Arrancar

```sh
npm install   # na raiz do monorepo (workspaces)
npm run dev   # dentro de packages/ui → http://localhost:5173/
npm run build # typecheck + build de produção
```

Requisitos: Node ≥ 20. O registo npm tem de estar acessível para `npm install`.

## O que funciona

- **Assistente de 4 passos** (tudo em português europeu):
  1. **Entrada** — separadores *Ficheiro de áudio* (seletor de ficheiro
     `accept="audio/*"`, mostra o nome do ficheiro) e *Tema* (textarea).
  2. **Voz** — motor TTS (Kokoro local / Edge-TTS), `<select>` de vozes e
     controlo de velocidade da fala (0,8×–1,2×).
  3. **Modelo visual** — 3 cartões de template (Social Intenso / Minimalista /
     Cinematográfico) com mini pré-visualizações reais em CSS, selecionáveis.
  4. **Formato e geração** — alternador 9:16 (Short) / 16:9 (Longo), escolha do
     modo de LLM e botão grande **Gerar vídeo**.
- **3 portas de revisão** (depois de carregar em *Gerar vídeo*):
  1. **Rever guião** — narração editável por segmento; "Regenerar segmento"
     é uma simulação visível (acrescenta "(rev. 2)").
  2. **Storyboard** — cartões com hook + força, palavras-chave visuais,
     descrição do B-roll e duração-alvo.
  3. **Render** — barra de progresso **marcada como simulação**; o botão
     *Descarregar MP4* está desativado com a etiqueta "em breve".
- **Modo browser (WebLLM)** — funcional de verdade: se o browser tiver WebGPU,
  o painel no passo 4 descarrega um modelo pequeno (Llama 3.2 1B) e permite
  fazer uma pergunta de teste. Tudo corre no browser, sem chave nem servidor.

## O que está stubbed (honesto)

| Peça | Estado |
|---|---|
| `src/lib/api.ts` | Cliente tipado do contrato REST (jobs, SSE, preview/download). As URLs e métodos já são reais; sem backend, cada chamada lança `Error('backend indisponível — Fase 2')`. |
| Geração da Spec (Fase A) | 2 segmentos gerados em código (`src/mock.ts`), marcados como dados de exemplo. |
| TTS / transcrição (Fase 2) | Só preferências na UI; vozes marcadas "(vozes reais na Fase 2)". |
| Render (Fases 3/4) | Barra de progresso simulada; download desativado ("em breve"). |

## Os 3 modos de LLM (passo 4)

1. **Cadeia cloud (chaves)** — o `llm-router` usa as chaves gratuitas
   configuradas (Gemini → Groq → OpenRouter :free → …) com failover
   automático. Implementação na Fase 2.
2. **Sem chave (Pollinations)** — zero configuração; o router salta os
   providers com chave e usa o provider keyless. Implementação na Fase 2.
3. **No browser (WebGPU, sem chave)** — **já funciona**: modelo pequeno corre
   via WebGPU neste browser (`src/lib/webllm.ts`, pacote `@mlc-ai/web-llm`
   carregado por `import()` dinâmico — nunca entra no bundle inicial).
   Avisos honestos: a primeira carga descarrega o modelo (cache do browser
   nas seguintes) e só serve para Specs curtas — tem mais latência.

## Ficheiros principais

```
packages/ui/
├── index.html
├── vite.config.ts          # dev em http://localhost:5173/
├── src/
│   ├── main.tsx            # entrypoint
│   ├── App.tsx             # máquina de estados (wizard + 3 portas)
│   ├── state.ts            # tipos do estado (useState simples)
│   ├── mock.ts             # dados de exemplo (2 segmentos)
│   ├── styles.css
│   ├── components/
│   │   ├── StepInput.tsx   # passo 1 — Entrada
│   │   ├── StepVoice.tsx   # passo 2 — Voz
│   │   ├── StepVisual.tsx  # passo 3 — Modelo visual
│   │   ├── StepFormat.tsx  # passo 4 — Formato + modo LLM + Gerar
│   │   ├── GateScript.tsx  # porta 1 — Rever guião
│   │   ├── GateStoryboard.tsx # porta 2 — Storyboard
│   │   └── GateRender.tsx  # porta 3 — Render (simulação)
│   └── lib/
│       ├── api.ts          # cliente REST tipado (stub honesto)
│       └── webllm.ts       # adaptador WebLLM (REAL)
```

## Fase 5: ligar ao backend

1. Arrancar o `pipeline` a servir `http://localhost:3000/api` (contrato em
   `ARCHITECTURE.md` §8). O `api.ts` já aponta para lá — nenhuma mudança
   na UI é precisa para as chamadas começarem a funcionar.
2. Substituir `generateMockSpec()` por `createJob()` + `generateSpec()`
   (Fase A real) e ligar as portas de revisão a `approveSpec()`.
3. Ligar o progresso do render a `subscribeJobEvents()` (SSE) em vez da
   simulação, e ativar o download com `getDownloadUrl()` quando o job
   estiver `done`.
4. (Opcional) Passar a servir a UI pelo próprio backend em
   `http://localhost:3000` conforme a arquitetura.
