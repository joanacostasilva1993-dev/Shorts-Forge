# @shorts-forge/llm-router

Cliente LLM compatível com a API OpenAI, com cadeia de fornecedores ordenada por
prioridade e **failover automático**. Se um fornecedor devolver `429` (quota/limite),
`5xx`, erro de rede ou timeout, o router passa silenciosamente ao fornecedor
seguinte — sem repetir o mesmo fornecedor dentro da mesma chamada.

Sem dependências de runtime: apenas `fetch` + `AbortController` nativos do Node.
Só `typescript` e `@types/node` como devDependencies.

## Instalação

```bash
cd packages/llm-router
npm install
npm run build
```

## Uso

```ts
import { createRouter, loadConfigFromEnv } from '@shorts-forge/llm-router';

const router = createRouter(loadConfigFromEnv());

// Chat simples
const res = await router.chat({
  messages: [
    { role: 'system', content: 'És um guionista de vídeos curtos.' },
    { role: 'user', content: 'Dá-me uma ideia de short sobre Lisboa.' },
  ],
  maxTokens: 500,
  timeoutMs: 30_000, // opcional; por omissão usa LLM_TIMEOUT_MS (60s)
});
console.log(res.text, res.provider, res.model); // ex.: "..." "groq" "llama-3.3-70b-versatile"

// JSON estruturado (para geração de specs do pipeline)
const spec = await router.chatJson<VideoSpec>({
  messages: [
    { role: 'system', content: 'Responde APENAS com JSON válido.' },
    { role: 'user', content: 'Gera a spec do vídeo: ...' },
  ],
});
console.log(spec.data); // já com JSON.parse feito
```

`chatJson` chama `chat` com `jsonMode: true` (envia
`response_format: { type: 'json_object' }`) e faz `JSON.parse` da resposta.
Se o texto não for JSON válido, lança um `Error` com o nome do fornecedor e um
excerto de 200 caracteres da resposta.

## Fornecedores por omissão (por ordem de prioridade)

| # | Nome | Modelo por omissão | Chave | Notas |
|---|------|--------------------|-------|-------|
| 1 | `gemini` | `gemini-2.5-flash` | `GEMINI_API_KEY` | Quota diária gratuita generosa |
| 2 | `groq` | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | Rápido; limites diários renováveis |
| 3 | `openrouter` | `qwen/qwen3-235b-a22b:free` | `OPENROUTER_API_KEY` | Modelos `:free` |
| 4 | `mistral` | `mistral-small-latest` | `MISTRAL_API_KEY` | Tier gratuito |
| 5 | `cerebras` | `llama-3.3-70b` | `CEREBRAS_API_KEY` | Tier gratuito, inferência rápida |
| 6 | `github-models` | `openai/gpt-4o-mini` | `GITHUB_TOKEN` | Reserva (não renova como os outros) |
| 7 | `pollinations` | `openai` | — (keyless) | Sem chave; último recurso na cloud |
| 8 | `ollama` | `qwen3:8b` | — (keyless) | Backstop local (`http://localhost:11434/v1`) |

Estratégia: gastar primeiro as quotas diárias renováveis (topo da lista) e
manter os recursos finitos / não renováveis como reserva. Os limites mudam com
o tempo — **nenhum limite está hardcoded**; o router reage a `429`s de forma
dinâmica, fazendo failover imediato.

## Variáveis de ambiente

| Variável | Efeito |
|----------|--------|
| `LLM_PROVIDERS` | Reordena a cadeia: ex. `"groq,gemini"`. Nomes desconhecidos são ignorados com aviso no `console.warn`; os fornecedores não listados mantêm a ordem relativa no fim. |
| `<NOME>_API_KEY` | Chave do fornecedor (`GEMINI_API_KEY`, `GROQ_API_KEY`, …). Exceção: `github-models` usa `GITHUB_TOKEN`. Fornecedores sem chave obrigatória são **ignorados silenciosamente** (exceto os `keyless`). |
| `<NOME>_BASE_URL` | Override do endpoint (ex. `GROQ_BASE_URL`, `OLLAMA_BASE_URL`). Útil para proxies ou testes. |
| `<NOME>_MODEL` | Override do modelo (ex. `GEMINI_MODEL=gemini-2.5-flash-lite`). |
| `LLM_TIMEOUT_MS` | Timeout global por omissão em ms (por omissão `60000`). `timeoutMs` no pedido tem precedência. |

Exemplo:

```bash
export GROQ_API_KEY="gsk_..."
export GEMINI_API_KEY="AIza..."
export LLM_PROVIDERS="groq,gemini,pollinations,ollama"
export LLM_TIMEOUT_MS=45000
```

## Comportamento de failover

Para cada chamada a `chat()`:

1. Os fornecedores são tentados por ordem de `priority` crescente.
2. Fornecedores sem chave obrigatória são ignorados sem tentativa.
3. Cada tentativa faz `POST {baseUrl}/chat/completions` com
   `{ model, messages, max_tokens?, response_format? }` e timeout via
   `AbortController`.
4. Há failover imediato em: HTTP `429`, `500`, `502`, `503`, `504`, erros de
   rede/DNS e timeout. Outros `4xx` (ex. chave inválida) também fazem failover,
   ficando registada a natureza do erro.
5. **O mesmo fornecedor nunca é tentado duas vezes na mesma chamada** —
   é failover, não retry loop.
6. Se todos falharem, é lançado um `Error` que lista cada fornecedor tentado
   com o respetivo erro (e os ignorados por falta de chave, se houver).

## Notas para o engenheiro de pipeline (geração de specs)

- Usa `router.chatJson<T>()` para specs estruturadas. Define o tipo `T` da spec
  (ex. `VideoSpec`) e passa-o como genérico — o retorno é
  `{ data: T; provider: string; model: string }`.
- Inclui sempre uma mensagem `system` a exigir "APENAS JSON válido" e descreve
  o schema no `user`. O `jsonMode` pede `json_object` ao fornecedor, mas a
  validação do schema é responsabilidade do chamador (ex. validação manual ou
  zod no pipeline).
- Se `chatJson` lançar por JSON inválido, a mensagem inclui o fornecedor e um
  excerto — podes registar e decidir se vale a pena nova chamada (que fará
  failover para outro fornecedor) ou abortar o job.
- `provider` e `model` no resultado servem para telemetria: regista que
  fornecedor gerou cada spec para auditares custos/quotas.

## Testes

```bash
npm test   # compila (tsc) e corre node:test sobre dist/test/
```

Os testes são 100% offline: levantam servidores HTTP locais que simulam
fornecedores OpenAI-compatíveis (429, 500, sucesso, JSON inválido, lentidão).
Cobrem: ordem de failover sem repetições, `chatJson` válido/inválido,
fornecedor sem chave ignorado, cabeçalho `Authorization`, reordenação via
`LLM_PROVIDERS`, overrides `<NOME>_MODEL`/`_BASE_URL`, erro agregado quando
tudo falha e failover por timeout.

> Nota: o script usa `node --test 'dist/test/*.test.js'` (glob explícito)
> porque esta versão do Node não expande diretórios passados ao `--test`.
