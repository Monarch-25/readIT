"""Shared HTTP layer for the Read-It TTS servers (MLX).

Serves the same contract as vLLM-Omni's speech API so the extension and
scripts work unchanged against any backend (see backends.py):

  GET  /healthz
  GET  /v1/audio/voices   -> {"voices":[...]}
  POST /v1/audio/speech   -> binary WAV
  POST /v1/audio/speech/batch -> {"results":[{index,status,audio_data}]}
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import uuid
from typing import Any, Protocol

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

MAX_BATCH = 32


class Backend(Protocol):
    name: str
    model_path: str
    default_voice: str
    voices: list[str]
    model: Any

    def load(self) -> None: ...
    @property
    def sample_rate(self) -> int: ...
    def voices_payload(self) -> dict[str, Any]: ...
    def synthesize(
        self,
        text: str,
        voice: str | None,
        language: str | None,
        instructions: str | None,
        max_new_tokens: int | None,
    ) -> np.ndarray: ...


def wav_bytes(audio: np.ndarray, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def bad_request(message: str, status: int = 400) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"message": message, "type": "BadRequestError", "param": None, "code": status}},
    )


async def read_json(request: Request) -> dict[str, Any]:
    raw = await request.body()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON: {exc}") from exc


def synthesize_many(backend: Backend, items: list[dict[str, Any]], defaults: dict[str, Any]) -> list[dict[str, Any]]:
    import logging

    log = logging.getLogger("tts_server")
    results: list[dict[str, Any]] = []
    for idx, item in enumerate(items):
        text = str(item.get("input") or "").strip()
        if not text:
            results.append({"index": idx, "status": "error", "error": "Input text cannot be empty"})
            continue
        try:
            audio = backend.synthesize(
                text=text,
                voice=item.get("voice", defaults.get("voice")),
                language=item.get("language", defaults.get("language")),
                instructions=item.get("instructions", defaults.get("instructions")),
                max_new_tokens=item.get("max_new_tokens", defaults.get("max_new_tokens")),
            )
            buf = io.BytesIO()
            sf.write(buf, audio, backend.sample_rate, format="WAV", subtype="PCM_16")
            seconds = int(audio.size / backend.sample_rate)
            results.append({
                "index": idx,
                "status": "success",
                "audio_data": base64.b64encode(buf.getvalue()).decode("ascii"),
                "media_type": "audio/wav",
                "usage": {"input_tokens": len(text), "output_tokens": seconds, "total_tokens": len(text) + seconds},
            })
            log.info(
                "batch item %d ok: backend=%s voice=%s lang=%s duration=%.2fs text=%r",
                idx, backend.name, item.get("voice", defaults.get("voice")),
                item.get("language", defaults.get("language")),
                audio.size / backend.sample_rate, text[:40],
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("batch item %d failed", idx)
            results.append({"index": idx, "status": "error", "error": str(exc)})
    return results


def build_app(backend: Backend) -> FastAPI:
    app = FastAPI(title="Read-It MLX TTS server", version="0.2.0")

    @app.on_event("startup")
    async def _startup() -> None:
        # Load in a worker thread so the event loop stays responsive.
        await asyncio.to_thread(backend.load)

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return {"ok": backend.model is not None, "model": backend.model_path, "voices": len(backend.voices)}

    @app.get("/v1/audio/voices")
    async def voices() -> dict[str, Any]:
        return backend.voices_payload()

    @app.post("/v1/audio/speech")
    async def speech(request: Request) -> Response:
        try:
            body = await read_json(request)
        except ValueError as exc:
            return bad_request(str(exc))
        text = str(body.get("input") or "")
        if not text.strip():
            return bad_request("Input text cannot be empty")
        if body.get("speed") not in (None, 1, 1.0):
            return bad_request("this server generates at speed 1.0; the browser applies playbackRate")
        try:
            audio = await asyncio.to_thread(
                backend.synthesize,
                text,
                body.get("voice"),
                body.get("language"),
                body.get("instructions") or body.get("instruction"),
                body.get("max_new_tokens"),
            )
        except Exception as exc:  # noqa: BLE001
            import logging

            logging.getLogger("tts_server").exception("speech failed")
            return bad_request(str(exc), status=500)
        data = wav_bytes(audio, backend.sample_rate)
        return Response(
            content=data,
            media_type="audio/wav",
            headers={
                "content-length": str(len(data)),
                "x-read-it-backend": backend.name,
                "x-vllm-omni-input-text-tokens": str(len(text)),
            },
        )

    @app.post("/v1/audio/speech/batch")
    async def speech_batch(request: Request) -> Response:
        try:
            body = await read_json(request)
        except ValueError as exc:
            return bad_request(str(exc))
        items = body.get("items")
        if not isinstance(items, list):
            return bad_request("items must be an array")
        if len(items) > MAX_BATCH:
            return bad_request(f"too many items (max {MAX_BATCH})")
        defaults = {
            "voice": body.get("voice"),
            "language": body.get("language"),
            "instructions": body.get("instructions"),
            "max_new_tokens": body.get("max_new_tokens"),
        }
        results = await asyncio.to_thread(synthesize_many, backend, items, defaults)
        payload = {
            "id": f"speech-batch-{uuid.uuid4().hex[:8]}",
            "results": results,
            "total": len(results),
            "succeeded": sum(1 for r in results if r["status"] == "success"),
            "failed": sum(1 for r in results if r["status"] != "success"),
        }
        return JSONResponse(content=payload)

    return app


def serve(backend: Backend, host: str, port: int, log_level: str = "info") -> None:
    import logging

    log = logging.getLogger("tts_server")
    log.info("serving %s on http://%s:%d", backend.name, host, port)
    uvicorn.run(build_app(backend), host=host, port=port, log_level=log_level, access_log=False)
