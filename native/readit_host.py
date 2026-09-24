#!/usr/bin/env python3
"""Read-It native messaging host (macOS, MLX).

Chrome/Arc/Comet/Brave launch this over stdio (one process per message).
It owns the lifecycle of the local MLX TTS servers so the user never has
to touch a terminal:

  {"cmd": "ping"}                        -> {"ok": true, "version": ...}
  {"cmd": "status"}                      -> server + model + recent log lines
  {"cmd": "download", "backend"?}        -> spawn detached weight download
  {"cmd": "start", "backend"?, "port"?}  -> adopt-or-spawn server, wait healthy
  {"cmd": "stop", "backend"?}            -> SIGTERM the server (idempotent)

Run with --download to act as the detached download worker instead.

State lives in <app>/logs/: <backend>.pid, download.json, <backend>.log,
where <app> is the directory containing this file — i.e. the runtime dir
installed by install.sh (~/Library/ReadIt). Only stdlib is used here; the
download worker imports huggingface_hub lazily (it runs under the runtime
.venv).
"""
from __future__ import annotations

import json
import os
import signal
import struct
import subprocess
import sys
import time
import urllib.request

VERSION = "0.4.0"
HOST_NAME = "com.readit.tts"

APP = os.path.dirname(os.path.abspath(__file__))
LOGS = os.path.join(APP, "logs")
VENV_PY = os.path.join(APP, ".venv", "bin", "python")

BACKENDS = {
    "kokoro": {
        "script": os.path.join(APP, "server", "serve_kokoro.py"),
        "port": 8902,
        "model": "mlx-community/Kokoro-82M-bf16",
        "label": "Kokoro-82M",
    },
}


def _paths(backend: str) -> dict[str, str]:
    return {
        "pid": os.path.join(LOGS, f"{backend}.pid"),
        "log": os.path.join(LOGS, f"{backend}.log"),
        "download": os.path.join(LOGS, "download.json"),
    }


def _read_message() -> dict:
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        raise EOFError("no message")
    (length,) = struct.unpack("<I", raw_len)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def _write_message(obj: dict) -> None:
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ValueError, OverflowError):
        return False


def _healthz(port: int, timeout: float = 3.0) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None


def _du_bytes(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def _hf_snapshot_dir(model: str) -> str:
    # Mirror huggingface_hub's cache layout without importing it.
    cache = os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")
    return os.path.join(cache, "models--" + model.replace("/", "--"))


def cmd_status(msg: dict) -> dict:
    backend = str(msg.get("backend") or "kokoro")
    cfg = BACKENDS.get(backend, BACKENDS["kokoro"])
    paths = _paths(backend)
    raw_pid: str | None = None
    try:
        raw_pid = open(paths["pid"]).read().strip()
    except (OSError, ValueError):
        raw_pid = None
    adopted_marker = raw_pid == "adopted"

    pid = None
    if raw_pid and not adopted_marker:
        try:
            pid = int(raw_pid)
        except ValueError:
            pid = None
    alive = bool(pid and _pid_alive(pid))
    health = _healthz(cfg["port"]) if (alive or adopted_marker) else None
    if adopted_marker and not health:
        # A previously adopted server went away; drop the stale marker.
        adopted_marker = False
        try:
            os.remove(paths["pid"])
        except OSError:
            pass
    running = bool(health and health.get("ok"))
    starting = bool((alive or adopted_marker) and not running)

    snap = _hf_snapshot_dir(cfg["model"])
    downloaded = os.path.isdir(snap) and _du_bytes(snap) > 0
    dl_state: dict = {}
    try:
        dl_state = json.load(open(paths["download"]))
    except (OSError, ValueError):
        dl_state = {}
    downloading = dl_state.get("state") == "downloading"

    tail: list[str] = []
    try:
        with open(paths["log"], "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 8192))
            tail = f.read().decode("utf-8", "replace").splitlines()[-12:]
    except OSError:
        pass

    return {
        "ok": True,
        "server": {
            "backend": backend,
            "label": cfg["label"],
            "running": running,
            "starting": starting,
            "adopted": adopted_marker and (running or starting),
            "pid": pid,
            "port": cfg["port"],
            "endpoint": f"http://127.0.0.1:{cfg['port']}",
            "health": health,
        },
        "model": {
            "id": cfg["model"],
            "downloaded": downloaded,
            "bytes": _du_bytes(snap) if downloaded else 0,
            "downloading": downloading,
            "download": dl_state,
        },
        "log_tail": tail,
    }


def cmd_start(msg: dict) -> dict:
    backend = str(msg.get("backend") or "kokoro")
    cfg = BACKENDS.get(backend, BACKENDS["kokoro"])
    port = int(msg.get("port") or cfg["port"])
    paths = _paths(backend)
    os.makedirs(LOGS, exist_ok=True)

    snap = _hf_snapshot_dir(cfg["model"])
    if not (os.path.isdir(snap) and _du_bytes(snap) > 0):
        return {"ok": False, "error": "weights-missing",
                "message": f"{cfg['label']} weights are not downloaded yet. Download them first."}

    # Adopt an already-healthy server (ours or manually started).
    health = _healthz(port)
    if health and health.get("ok"):
        with open(paths["pid"], "w") as f:
            f.write("adopted")
        return {"ok": True, "endpoint": f"http://127.0.0.1:{port}", "adopted": True}

    try:
        old_pid = int(open(paths["pid"]).read().strip())
    except (OSError, ValueError):
        old_pid = None
    if old_pid and _pid_alive(old_pid):
        pass  # stale-but-alive: fall through and wait for it
    else:
        logf = open(paths["log"], "ab")
        proc = subprocess.Popen(
            [VENV_PY, cfg["script"], "--port", str(port)],
            cwd=APP, stdout=logf, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        with open(paths["pid"], "w") as f:
            f.write(str(proc.pid))

    deadline = time.time() + 120
    last_err = "server did not become healthy"
    while time.time() < deadline:
        health = _healthz(port)
        if health and health.get("ok"):
            return {"ok": True, "endpoint": f"http://127.0.0.1:{port}", "adopted": False}
        time.sleep(1.0)
    return {"ok": False, "error": "unhealthy", "message": last_err}


def cmd_stop(msg: dict) -> dict:
    backend = str(msg.get("backend") or "kokoro")
    paths = _paths(backend)
    try:
        raw = open(paths["pid"]).read().strip()
    except (OSError, ValueError):
        return {"ok": True, "stopped": True}
    if raw == "adopted":
        return {"ok": False, "error": "not-managed",
                "message": "That server was not started by the helper (adopted) — stop it where you launched it."}
    try:
        pid = int(raw)
    except ValueError:
        return {"ok": True, "stopped": True}
    if _pid_alive(pid):
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        deadline = time.time() + 8
        while _pid_alive(pid) and time.time() < deadline:
            time.sleep(0.2)
        if _pid_alive(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
    try:
        os.remove(paths["pid"])
    except OSError:
        pass
    return {"ok": True, "stopped": True}


def cmd_download(msg: dict) -> dict:
    backend = str(msg.get("backend") or "kokoro")
    cfg = BACKENDS.get(backend, BACKENDS["kokoro"])
    os.makedirs(LOGS, exist_ok=True)
    paths = _paths(backend)
    try:
        state = json.load(open(paths["download"]))
        if state.get("state") == "downloading" and state.get("backend") == backend:
            return {"ok": True, "started": False, "message": "download already running"}
    except (OSError, ValueError):
        pass
    with open(paths["download"], "w") as f:
        json.dump({"state": "downloading", "backend": backend, "model": cfg["model"],
                   "started_at": time.time(), "bytes": 0}, f)
    logf = open(os.path.join(LOGS, "download.log"), "ab")
    subprocess.Popen(
        [VENV_PY, os.path.abspath(__file__), "--download", backend],
        cwd=APP, stdout=logf, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return {"ok": True, "started": True}


def run_download_worker(backend: str) -> int:
    """Detached worker: fetch the model snapshot (+voices), report to download.json."""
    cfg = BACKENDS.get(backend, BACKENDS["kokoro"])
    paths = _paths(backend)

    def write(state: dict) -> None:
        try:
            with open(paths["download"], "w") as f:
                json.dump(state, f)
        except OSError:
            pass

    snap = _hf_snapshot_dir(cfg["model"])
    try:
        from huggingface_hub import snapshot_download

        # Voices ship in the same repo as .safetensors; skip the duplicate .pt copies.
        snapshot_download(repo_id=cfg["model"], ignore_patterns=["*.pt"])
        write({"state": "ready", "backend": backend, "model": cfg["model"],
               "finished_at": time.time(), "bytes": _du_bytes(snap)})
        return 0
    except Exception as exc:  # noqa: BLE001
        write({"state": "error", "backend": backend, "model": cfg["model"],
               "error": str(exc)[:500]})
        return 1


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--download":
        os.makedirs(LOGS, exist_ok=True)
        return run_download_worker(sys.argv[2] if len(sys.argv) > 2 else "kokoro")
    try:
        msg = _read_message()
    except EOFError:
        return 0
    cmd = str(msg.get("cmd") or "")
    try:
        if cmd == "ping":
            _write_message({"ok": True, "version": VERSION, "app": APP})
        elif cmd == "status":
            _write_message(cmd_status(msg))
        elif cmd == "download":
            _write_message(cmd_download(msg))
        elif cmd == "start":
            _write_message(cmd_start(msg))
        elif cmd == "stop":
            _write_message(cmd_stop(msg))
        else:
            _write_message({"ok": False, "error": "unknown-cmd", "message": f"unknown cmd: {cmd}"})
    except Exception as exc:  # noqa: BLE001 - never leave the extension hanging
        try:
            _write_message({"ok": False, "error": "host-error", "message": str(exc)[:500]})
        except Exception:  # noqa: BLE001
            pass
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
