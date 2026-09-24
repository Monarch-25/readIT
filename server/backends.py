"""Model backends for the Read-It TTS servers (MLX).

Each backend exposes the same small interface so the HTTP layer in
tts_server.py works unchanged:

    name            human/machine id, currently "mlx-kokoro"
    model_path      HF id or local path (reported by /healthz)
    default_voice   fallback voice
    voices          list of voice ids (populated by load())
    sample_rate     int
    load()          loads the model once (called in a worker thread)
    voices_payload()
    synthesize(text, voice, language, instructions, max_new_tokens)
        -> mono float32 numpy array in [-1, 1]
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any

import numpy as np

log = logging.getLogger("tts_backends")


class KokoroBackend:
    """Kokoro-82M via mlx-audio. 54 built-in voice presets; the voice id
    selects the language (af_*/am_* American English, bf_*/bm_* British,
    jf_*/jm_* Japanese, zf_*/zm_* Mandarin, ef_*/em_* Spanish, ff_* French,
    hf_*/hm_* Hindi, if_*/im_* Italian, pf_*/pm_* Portuguese).

    No style instructions or token limits — those parameters are accepted
    and ignored so the shared API contract holds.
    """

    name = "mlx-kokoro"

    # Canonical 54 presets from hexgrad/Kokoro-82M VOICES.md (af_heart first:
    # the reference A-grade American voice, and our default).
    VOICES = [
        "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore",
        "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
        "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
        "am_onyx", "am_puck", "am_santa",
        "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
        "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
        "ef_dora", "em_alex", "em_santa",
        "ff_siwis",
        "hf_alpha", "hf_beta", "hm_omega", "hm_psi",
        "if_sara", "im_nicola",
        "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo",
        "pf_dora", "pm_alex", "pm_santa",
        "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi",
        "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
    ]

    # Kokoro lang_code is the voice's first letter (espeak/misaki backend).
    LANG_BY_PREFIX = {
        "a": "a", "b": "b", "e": "e", "f": "f", "h": "h",
        "i": "i", "j": "j", "p": "p", "z": "z",
    }

    def __init__(self, model_path: str, default_voice: str, default_language: str):
        self.model_path = model_path
        self.default_voice = default_voice if default_voice in self.VOICES else "af_heart"
        self.default_language = default_language
        self.model = None
        self.voices: list[str] = list(self.VOICES)
        self._lock = threading.Lock()

    def load(self) -> None:
        from mlx_audio.tts.utils import load_model  # local import: slow

        log.info("loading MLX model %s ...", self.model_path)
        t0 = time.time()
        self.model = load_model(self.model_path)
        if self.default_voice not in self.voices and self.voices:
            self.default_voice = self.voices[0]
        log.info(
            "model ready in %.1fs, %d voices, sample_rate=%s",
            time.time() - t0, len(self.voices), getattr(self.model, "sample_rate", "?"),
        )

    @property
    def sample_rate(self) -> int:
        return int(getattr(self.model, "sample_rate", 24000))

    def voices_payload(self) -> dict[str, Any]:
        return {"voices": self.voices, "uploaded_voices": []}

    def synthesize(
        self,
        text: str,
        voice: str | None,
        language: str | None,
        instructions: str | None,
        max_new_tokens: int | None,
    ) -> np.ndarray:
        """Run one generation; returns mono float32 in [-1, 1]."""
        with self._lock:
            if self.model is None:
                raise RuntimeError("model not loaded")
            voice = (voice or self.default_voice)
            if voice not in self.voices:
                voice = self.default_voice
            lang_code = self.LANG_BY_PREFIX.get(voice[0].lower(), "a")

            audio_chunks = []
            for result in self.model.generate(
                text=text, voice=voice, speed=1.0, lang_code=lang_code
            ):
                audio_chunks.append(np.asarray(result.audio, dtype=np.float32).reshape(-1))
            if not audio_chunks:
                raise RuntimeError("empty generation")
            audio = np.concatenate(audio_chunks)
            peak = float(np.max(np.abs(audio))) if audio.size else 0.0
            if peak > 1.0:
                audio = audio / peak
            return audio
