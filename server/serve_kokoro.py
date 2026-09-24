#!/usr/bin/env python3
"""MLX Kokoro-82M server for Read-It (vLLM-Omni-compatible API).

Kokoro is an 82M-parameter open-weight TTS model with 54 built-in voice
presets. The voice id selects the language (af_*/am_* American English,
bf_*/bm_* British, ...), so the `language` request field is informational;
`instructions` and `max_new_tokens` are accepted and ignored (Kokoro takes
neither).

The extension popup talks to this server; any vLLM-Omni-compatible client
works too. Needs the misaki G2P package (see requirements.txt).

Usage:
  python serve_kokoro.py --port 8902
  python serve_kokoro.py --model mlx-community/Kokoro-82M-8bit --voice af_bella
"""
from __future__ import annotations

import argparse
import logging
import sys

from backends import KokoroBackend
from tts_server import serve

DEFAULT_MODEL = "mlx-community/Kokoro-82M-bf16"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="MLX Kokoro-82M server for Read-It (vLLM-Omni-compatible API)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8902)
    p.add_argument("--model", default=DEFAULT_MODEL, help="HF id or local path of the MLX checkpoint")
    p.add_argument("--voice", default="af_heart", help="default voice if request omits one")
    p.add_argument("--language", default="english")
    p.add_argument("--log-level", default="info")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    backend = KokoroBackend(args.model, args.voice, args.language)
    serve(backend, args.host, args.port, args.log_level)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
