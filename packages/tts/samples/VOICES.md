# Amostras de voz — shorts-forge

> **Para a Joana ouvir e aprovar a voz omissa.** Todas as amostras dizem o
> MESMO parágrafo em pt-PT (3 frases, pontuação variada: `!`, `.`, `:`, `?`),
> com `rate = 1.0`:
>
> «Olá! Bem-vindo ao shorts-forge. Hoje vamos transformar uma simples ideia
> num vídeo pronto a publicar: com narração clara, legendas sincronizadas e
> o ritmo certo. Preparado? Vamos a isto!»

## Amostras disponíveis

| Ficheiro | Provider | Voz | Género | Duração | Notas |
|---|---|---|---|---|---|
| `kokoro-pf_dora.mp3` | Kokoro (local) | `pf_dora` | feminina | 10,8 s | **Omissão atual.** Português do Brasil; a mais neutra das três |
| `kokoro-pm_alex.mp3` | Kokoro (local) | `pm_alex` | masculina | 10,8 s | Português do Brasil |
| `kokoro-pm_santa.mp3` | Kokoro (local) | `pm_santa` | masculina | 10,9 s | Português do Brasil, timbre mais grave |

## Amostras em falta (por gerar fora da sandbox)

| Ficheiro | Provider | Voz | Motivo |
|---|---|---|---|
| `edge-tts-pt-PT-DuarteNeural.mp3` | Edge-TTS | `pt-PT-DuarteNeural` (masc.) | a rede desta sandbox quebra o WebSocket do Edge-TTS (proxy MITM); gerar no PC da Joana com `generate_samples.py` |
| `edge-tts-pt-PT-RaquelNeural.mp3` | Edge-TTS | `pt-PT-RaquelNeural` (fem.) | idem |

## Factos verificados (não palpites)

- O Kokoro-82M (versão instalada: `kokoro==0.9.4`, repo `hexgrad/Kokoro-82M`)
  **não tem nenhuma voz pt-PT**. As únicas vozes portuguesas são as três
  acima — todas pt-BR. Isto é o **risco nº 1** do projeto: se a Joana quiser
  sotaque europeu genuíno, a omissão tem de ser `edge-tts`
  (`pt-PT-DuarteNeural` / `pt-PT-RaquelNeural`, nomes confirmados via
  `list_voices()` em runtime) ou `google` (ex. `pt-PT-Neural2-A`, a
  confirmar com credenciais).
- A avaliação de **naturalidade** é subjetiva e tem de ser feita a ouvido —
  é para isso que estas amostras existem. O que está tecnicamente
  garantido: áudio a 128 kbps MP3, `durationSec` medido por ffprobe e
  `words[]` com timestamps medidos (re-temporização faster-whisper).

## Como gerar / regenerar

```bash
cd packages/tts/service
.venv/bin/python generate_samples.py
```

O script salta amostras que já existam. Para forçar regeneração, apaga o
ficheiro primeiro.
