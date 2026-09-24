#!/usr/bin/env python3
"""CLI client for the Read-It Kokoro server (or any vLLM-Omni endpoint).

Examples:
  # probe voices
  python tts_client.py --endpoint http://127.0.0.1:8902 voices

  # one utterance -> wav file (the voice id picks the language)
  python tts_client.py --endpoint http://127.0.0.1:8902 speak \
      --text "The rains came late that autumn." --voice af_heart -o out.wav

  # batch of sentences -> directory of wavs
  python tts_client.py --endpoint http://127.0.0.1:8902 batch \
      --texts-file sentences.txt --voice af_bella -o outdir/
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_ENDPOINT = "http://127.0.0.1:8902"


def request(endpoint: str, path: str, payload: dict | None = None, timeout: float = 120.0):
    url = endpoint.rstrip("/") + path
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if payload is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            if "application/json" in ctype:
                return resp.status, json.loads(body), ctype
            return resp.status, body, ctype
    except urllib.error.HTTPError as exc:  # HTTP error with body
        body = exc.read()
        try:
            parsed = json.loads(body)
        except Exception:  # noqa: BLE001
            parsed = {"raw": body.decode("utf-8", "replace")}
        return exc.code, parsed, exc.headers.get("Content-Type", "")
    except urllib.error.URLError as exc:
        raise SystemExit(f"connection failed: {exc.reason}")


def speak_payload(text: str, args: argparse.Namespace) -> dict:
    return {
        "input": text,
        "model": args.model,
        "voice": args.voice,
        "response_format": "wav",
        "speed": 1.0,
        "task_type": "CustomVoice",
        "language": args.language,
        "instructions": args.instructions or None,
        "max_new_tokens": args.max_new_tokens,
    }


def batch_payload(texts: list[str], args: argparse.Namespace) -> dict:
    return {
        "items": [{"input": t} for t in texts],
        "voice": args.voice,
        "response_format": "wav",
        "speed": 1.0,
        "task_type": "CustomVoice",
        "language": args.language,
        "instructions": args.instructions or None,
        "max_new_tokens": args.max_new_tokens,
    }


def cmd_voices(args: argparse.Namespace) -> int:
    status, body, _ = request(args.endpoint, "/v1/audio/voices")
    if status != 200:
        print(f"error: HTTP {status}: {body}", file=sys.stderr)
        return 1
    print(json.dumps(body, indent=2, ensure_ascii=False))
    return 0


def cmd_speak(args: argparse.Namespace) -> int:
    text = args.text
    if args.text_file:
        text = Path(args.text_file).read_text(encoding="utf-8").strip()
    if not text:
        print("error: empty text", file=sys.stderr)
        return 1
    status, body, _ = request(args.endpoint, "/v1/audio/speech", speak_payload(text, args))
    if status != 200:
        print(f"error: HTTP {status}: {json.dumps(body, ensure_ascii=False)}", file=sys.stderr)
        return 1
    out = Path(args.output or "out.wav")
    out.write_bytes(body)
    print(f"wrote {out} ({out.stat().st_size} bytes)")
    return 0


def cmd_batch(args: argparse.Namespace) -> int:
    texts: list[str] = []
    if args.texts_file:
        texts = [ln for ln in Path(args.texts_file).read_text(encoding="utf-8").splitlines() if ln.strip()]
    elif args.text:
        texts = [args.text]
    if not texts:
        print("error: no texts", file=sys.stderr)
        return 1
    status, body, _ = request(args.endpoint, "/v1/audio/speech/batch", batch_payload(texts, args))
    if status != 200:
        print(f"error: HTTP {status}: {json.dumps(body, ensure_ascii=False)}", file=sys.stderr)
        return 1
    outdir = Path(args.output or "batch_out")
    outdir.mkdir(parents=True, exist_ok=True)
    ok = 0
    for item in body.get("results", []):
        idx = item.get("index")
        if item.get("status") != "success":
            print(f"item {idx}: {item.get('error')}", file=sys.stderr)
            continue
        raw = base64.b64decode(item["audio_data"])
        path = outdir / f"sentence_{idx:03d}.wav"
        path.write_bytes(raw)
        ok += 1
    print(f"wrote {ok}/{len(texts)} wav files to {outdir}/")
    return 0 if ok == len(texts) else 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--endpoint", default=DEFAULT_ENDPOINT, help="server base URL")
    sub = p.add_subparsers(dest="cmd", required=True)

    v = sub.add_parser("voices", help="GET /v1/audio/voices")
    v.set_defaults(func=cmd_voices)

    s = sub.add_parser("speak", help="POST /v1/audio/speech (single)")
    s.add_argument("--text", default=None)
    s.add_argument("--text-file", default=None)
    s.add_argument("--voice", default="af_heart")
    s.add_argument("--language", default="english")
    s.add_argument("--instructions", default="")
    s.add_argument("--model", default=None)
    s.add_argument("--max-new-tokens", dest="max_new_tokens", type=int, default=2048)
    s.add_argument("-o", "--output", default=None, help="output wav path")
    s.set_defaults(func=cmd_speak)

    b = sub.add_parser("batch", help="POST /v1/audio/speech/batch")
    b.add_argument("--text", default=None, help="single sentence")
    b.add_argument("--texts-file", default=None, help="one sentence per line")
    b.add_argument("--voice", default="af_heart")
    b.add_argument("--language", default="english")
    b.add_argument("--instructions", default="")
    b.add_argument("--model", default=None)
    b.add_argument("--max-new-tokens", dest="max_new_tokens", type=int, default=2048)
    b.add_argument("-o", "--output", default=None, help="output directory")
    b.set_defaults(func=cmd_batch)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())