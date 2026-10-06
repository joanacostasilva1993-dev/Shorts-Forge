# SPDX-License-Identifier: AGPL-3.0-only
"""Google Cloud TTS provider — first-class but optional.

Implements docs/tts-providers.md §5 EXACTLY:

1. Tokenize the text into words ``w[0..n-1]``.
2. Build SSML with ``<mark name="w{i}"/>`` BEFORE each word (XML-escaped).
3. Call the **v1beta1** ``text:synthesize`` endpoint with
   ``enable_time_pointing=["SSML_MARK"]`` (the stable ``v1`` API does NOT
   support time pointing).
4. Map ``words[i].start = timepoints["w{i}"].time_seconds``;
   ``words[i].end = words[i+1].start``; the last word ends at the measured
   ``duration_sec`` of the generated MP3 (ffprobe — never estimated).
5. VALIDATION GATE: if the returned timepoint count != word count, discard
   EVERYTHING and fall back to the faster-whisper re-timing of the MP3.
   Partial timepoints are never mixed with estimates.

Auth precedence: GOOGLE_APPLICATION_CREDENTIALS (file must exist) >
GOOGLE_TTS_API_KEY > provider unavailable (never fatal — the service falls
back to kokoro/edge-tts).

No Google credentials exist in this dev environment, so live calls are NOT
tested here; the marks/tokenize/map logic is unit-tested with mocks and
live testing is flagged as "needs Joana's credentials".
"""

from __future__ import annotations

import base64
import json
import os

import urllib.parse
import urllib.request
from pathlib import Path

from providers.base import ProviderResult, ProviderUnavailable, SynthesisError, TtsProvider
import config
from word_timing import build_marked_ssml, map_timepoints_to_words, measure_duration_sec, tokenize

_API_KEY_ENV = "GOOGLE_TTS_API_KEY"
_ADC_ENV = "GOOGLE_APPLICATION_CREDENTIALS"
_SYNTHESIZE_URL = "https://texttospeech.googleapis.com/v1beta1/text:synthesize"


def _looks_like_placeholder(value: str) -> bool:
    v = value.strip()
    return (v.startswith("<") and v.endswith(">")) or "caminho/para" in v or "cola-aqui" in v


def resolve_auth() -> tuple[str, str | None]:
    """Return (mode, credential) where mode is 'service_account' | 'api_key'.

    Raises ProviderUnavailable when neither is configured. A
    GOOGLE_APPLICATION_CREDENTIALS value whose file does not exist does NOT
    count — precedence falls through to the API key.
    """
    adc = os.environ.get(_ADC_ENV, "").strip()
    if adc and not _looks_like_placeholder(adc) and Path(adc).is_file():
        return "service_account", adc
    key = os.environ.get(_API_KEY_ENV, "").strip()
    if key and not _looks_like_placeholder(key):
        return "api_key", key
    raise ProviderUnavailable(
        "Google Cloud TTS indisponível: configura GOOGLE_APPLICATION_CREDENTIALS "
        "(ficheiro da service account) ou GOOGLE_TTS_API_KEY."
    )


def _language_code_from_voice(voice: str) -> str:
    """Infer the BCP-47 language code from a voice name like pt-PT-Neural2-A."""
    parts = voice.split("-")
    if len(parts) >= 2 and len(parts[0]) == 2 and len(parts[1]) == 2:
        return f"{parts[0]}-{parts[1]}"
    return "pt-PT"




class GoogleProvider(TtsProvider):
    name = "google"

    def __init__(self) -> None:
        self._lib_checked: bool | None = None

    def default_voice(self) -> str:
        return config.GOOGLE_TTS_VOICE

    def is_available(self) -> bool:
        try:
            resolve_auth()
        except ProviderUnavailable:
            return False
        return self._client_library_present()

    def _client_library_present(self) -> bool:
        if self._lib_checked is None:
            try:
                __import__("google.cloud.texttospeech_v1beta1")
                self._lib_checked = True
            except ImportError:
                self._lib_checked = False
        return self._lib_checked

    # -- synthesis ------------------------------------------------------
    def synthesize(self, text: str, voice: str, rate: float) -> ProviderResult:
        mode, _cred = resolve_auth()  # raises ProviderUnavailable when unusable
        words = tokenize(text)
        if not words:
            raise SynthesisError("texto vazio — nada para sintetizar.")
        voice = voice.strip() or self.default_voice()
        ssml = build_marked_ssml(words)
        speaking_rate = min(4.0, max(0.25, rate))

        audio_bytes, timepoints = self._call_api(
            ssml, voice, speaking_rate, mode,
            language_code=_language_code_from_voice(voice),
        )
        out_path = self._persist(audio_bytes)
        duration_sec = measure_duration_sec(out_path)

        # Validation gate — all or nothing.
        mapped = map_timepoints_to_words(words, timepoints, duration_sec)
        if mapped is None:
            # Fallback obrigatório: faster-whisper sobre o MP3 gerado.
            from whisper_retime import retime_with_whisper

            words_out = retime_with_whisper(out_path, words)
        else:
            words_out = mapped.words
        return ProviderResult(
            audio_path=out_path, words=words_out,
            duration_sec=duration_sec, voice=voice,
        )

    def _persist(self, audio_bytes: bytes) -> str:
        import uuid

        path = config.OUTPUT_DIR / f"google-{uuid.uuid4().hex[:12]}.mp3"
        path.write_bytes(audio_bytes)
        return str(path)

    # -- API call: client library preferred, REST fallback ----------------
    def _call_api(
        self, ssml: str, voice: str, speaking_rate: float,
        mode: str, language_code: str,
    ) -> tuple[bytes, list[tuple[str, float]]]:
        """Return (mp3_bytes, [(mark_name, time_seconds)])."""
        if self._client_library_present():
            return self._call_via_library(ssml, voice, speaking_rate, mode, language_code)
        return self._call_via_rest(ssml, voice, speaking_rate, mode, language_code)

    def _call_via_library(
        self, ssml: str, voice: str, speaking_rate: float,
        mode: str, language_code: str,
    ) -> tuple[bytes, list[tuple[str, float]]]:
        from google.cloud import texttospeech_v1beta1 as tts

        if mode == "api_key":
            # Client-library auth with a plain API key (no ADC involved).
            from google.api_core import client_options as co

            key = os.environ[_API_KEY_ENV].strip()
            client = tts.TextToSpeechClient(
                client_options=co.ClientOptions(api_key=key)
            )
        else:
            # Service account: ADC honours GOOGLE_APPLICATION_CREDENTIALS.
            client = tts.TextToSpeechClient()
        request = tts.SynthesizeSpeechRequest(
            input=tts.SynthesisInput(ssml=ssml),
            voice=tts.VoiceSelectionParams(
                language_code=language_code, name=voice
            ),
            audio_config=tts.AudioConfig(
                audio_encoding=tts.AudioEncoding.MP3,
                speaking_rate=speaking_rate,
            ),
            # v1beta1-only: the stable v1 API does NOT support time pointing.
            enable_time_pointing=[tts.TimepointType.SSML_MARK],
        )
        response = client.synthesize_speech(request=request)
        timepoints = [
            (tp.mark_name, tp.time_seconds) for tp in response.timepoints
        ]
        return response.audio_content, timepoints

    def _call_via_rest(
        self, ssml: str, voice: str, speaking_rate: float,
        mode: str, language_code: str,
    ) -> tuple[bytes, list[tuple[str, float]]]:
        """Raw HTTPS fallback when the client library is not installed."""
        body = {
            "input": {"ssml": ssml},
            "voice": {"languageCode": language_code, "name": voice},
            "audioConfig": {"audioEncoding": "MP3", "speakingRate": speaking_rate},
            "enableTimePointing": ["SSML_MARK"],
        }
        data = json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json; charset=utf-8"}
        url = _SYNTHESIZE_URL
        if mode == "api_key":
            # Service-account mode without the library cannot mint OAuth2
            # tokens here — report unavailable instead of failing obscurely.
            url += "?key=" + urllib.parse.quote(os.environ[_API_KEY_ENV].strip())
        else:
            raise ProviderUnavailable(
                "Google Cloud TTS indisponível: autenticação por service account "
                "exige a biblioteca google-cloud-texttospeech instalada."
            )
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                payload = json.loads(res.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 — surfaced as pt-PT message
            raise SynthesisError(f"a API do Google Cloud TTS falhou: {exc}")
        audio_bytes = base64.b64decode(payload["audioContent"])
        timepoints = [
            (tp["markName"], float(tp["timeSeconds"]))
            for tp in payload.get("timepoints", [])
        ]
        return audio_bytes, timepoints
