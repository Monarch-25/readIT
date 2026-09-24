#!/usr/bin/env python3
"""MLX Qwen3-TTS server for Read-It (vLLM-Omni-compatible API).

Backed by mlx-audio's Qwen3TTS model (mlx-community checkpoints).
Shared HTTP layer lives in tts_server.py; model logic in backends.py.

Usage:
  python serve_mlx.py --port 8901 \
      --model mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit
"""
from __future__ import annotations

import argparse
import logging
import sys

from backends import QwenBackend
from tts_server import serve

DEFAULT_MODEL = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="MLX Qwen3-TTS server for Read-It (vLLM-Omni-compatible API)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8901)
    p.add_argument("--model", default=DEFAULT_MODEL, help="HF id or local path of the MLX checkpoint")
    p.add_argument("--voice", default="aiden", help="default voice if request omits one")
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
    backend = QwenBackend(args.model, args.voice, args.language)
    serve(backend, args.host, args.port, args.log_level)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
