#!/usr/bin/env bash
# Launch vLLM-Omni with Qwen3-TTS-12Hz-0.6B-CustomVoice (GPU machine).
#
# Prereqs (from the vLLM-Omni README, versions aligned to the vllm line you use):
#   git clone https://github.com/vllm-project/vllm-omni && cd vllm-omni
#   # pick the tag matching your CUDA/vllm install, e.g. v0.6.x
#   uv venv --python 3.12 && . .venv/bin/activate
#   uv pip install -e . --no-build-isolation
#
# Then:
#   ./server/serve_vllm.sh                 # default port 8091
#   PORT=8091 ./server/serve_vllm.sh
#
# The extension's "Connect" probe hits GET /v1/audio/voices on this port.
set -euo pipefail

MODEL="${MODEL:-Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice}"
PORT="${PORT:-8091}"
HOST="${HOST:-0.0.0.0}"
DEPLOY_CONFIG="${DEPLOY_CONFIG:-vllm_omni/deploy/qwen3_tts.yaml}"

if ! command -v vllm >/dev/null 2>&1; then
  echo "error: 'vllm' not on PATH. Install vLLM-Omni first (see header comments)." >&2
  exit 1
fi

echo "Serving ${MODEL} on http://${HOST}:${PORT} (deploy=${DEPLOY_CONFIG})"
exec vllm serve "${MODEL}" \
  --deploy-config "${DEPLOY_CONFIG}" \
  --omni \
  --port "${PORT}" \
  --host "${HOST}" \
  --trust-remote-code \
  --enforce-eager