#!/usr/bin/env bash
# Read-It one-step installer (macOS, Apple Silicon M2/M3/M4/M5).
#
#   ./install.sh              # runtime install + browser helper registration
#   ./install.sh --download   # ...plus prefetch the Kokoro weights now
#   ./install.sh doctor       # diagnose helper/registration problems
#
# What goes where:
#   this repo            extension sources, python sources, docs (stays put)
#   ~/Library/ReadIt/    runtime: .venv, host + server code, logs  (created here)
#   <browser>/NativeMessagingHosts/com.readit.tts.json  (one small file each)
#   ~/.cache/huggingface  model weights (shared cache)
#
# Why ~/Library/ReadIt and not the repo folder: sandboxed browsers (Comet)
# refuse to execute anything outside blessed locations; ~/Library is the
# user-writable one they allow. After this, the only manual step is loading
# the unpacked extension in your browser (see README).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HOME/Library/ReadIt"
HOST_NAME="com.readit.tts"
DOWNLOAD_NOW=0
DOCTOR=0

for arg in "$@"; do
  case "$arg" in
    --download) DOWNLOAD_NOW=1 ;;
    doctor) DOCTOR=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg (try --download or doctor)" >&2; exit 1 ;;
  esac
done

say()  { printf '\033[1m[read-it]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[read-it]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[read-it]\033[0m %s\n' "$*" >&2; exit 1; }

APP_SUP="$HOME/Library/Application Support"
CANDIDATES=(
  "$APP_SUP/Google/Chrome"
  "$APP_SUP/Chromium"
  "$APP_SUP/BraveSoftware/Brave-Browser"
  "$APP_SUP/Microsoft Edge"
  "$APP_SUP/Arc/User Data"
  "$APP_SUP/Comet"
  "$APP_SUP/Dia"
)

# --- doctor: diagnose without changing anything ----------------------------------
if [[ "$DOCTOR" -eq 1 ]]; then
  say "repo: $REPO"
  say "runtime: $APP"
  [[ -x "$APP/.venv/bin/python" ]] \
    && say "runtime venv: OK ($("$APP/.venv/bin/python" -c 'import sys; print(sys.version.split()[0])'))" \
    || warn "runtime venv MISSING — run ./install.sh"
  for f in readit_host.py readit_host.sh server/serve_kokoro.py server/backends.py server/tts_server.py; do
    [[ -f "$APP/$f" ]] && say "runtime file $f: OK" || warn "runtime file $f MISSING — run ./install.sh"
  done
  echo "--- native-messaging manifests ---"
  found=0
  for base in "${CANDIDATES[@]}"; do
    f="$base/NativeMessagingHosts/$HOST_NAME.json"
    if [[ -f "$f" ]]; then
      found=1
      target="$(python3 -c "import json;print(json.load(open('$f'))['path'])" 2>/dev/null || echo "?")"
      if [[ -x "$target" ]]; then st="OK (launcher runs)"; else st="BROKEN (launcher missing: $target)"; fi
      say "$(basename "$base"): registered — $st"
    else
      if [[ -d "$base" ]]; then say "$(basename "$base"): browser present but NOT registered"; fi
    fi
  done
  [[ "$found" -eq 0 ]] && warn "helper is not registered in ANY browser — run ./install.sh"
  echo "--- weights & ports ---"
  du -shL ~/.cache/huggingface/hub/models--mlx-community--Kokoro-82M-bf16 2>/dev/null \
    || echo "Kokoro weights: not downloaded"
  for port in 8902; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      say "port $port: LISTENING ($(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' '))"
    else
      say "port $port: free"
    fi
  done
  echo "--- checklist ---"
  echo "Extension id in chrome://extensions must be: dnpkdcbdccnpnmcojaemknfbnfkfkgld"
  exit 0
fi

# --- 1. platform -------------------------------------------------------------------
[[ "$(uname -s)" == "Darwin" ]] || die "macOS only (found $(uname -s))."
[[ "$(uname -m)" == "arm64" ]] || die "Apple Silicon required (found $(uname -m)). MLX does not run on Intel Macs."
say "macOS $(sw_vers -productVersion) on $(uname -m) — good."

# --- 2. python -----------------------------------------------------------------------
command -v python3 >/dev/null || die "python3 not found. Install Python 3.12 from python.org (or: brew install python@3.12)."
PYVER="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
PYMAJ="$(python3 -c 'import sys; print(sys.version_info.major)')"
PYMIN="$(python3 -c 'import sys; print(sys.version_info.minor)')"
if [[ "$PYMAJ" -lt 3 || "$PYMIN" -lt 10 ]]; then
  die "Python >= 3.10 required (found $PYVER). Install 3.12 from python.org."
fi
say "python3 $PYVER — good."

# --- 3. runtime dir + venv + deps -------------------------------------------------------
mkdir -p "$APP/server" "$APP/logs"
if [[ ! -x "$APP/.venv/bin/python" ]]; then
  say "creating runtime virtualenv…"
  python3 -m venv "$APP/.venv"
fi
say "installing python dependencies (a few minutes on first run)…"
"$APP/.venv/bin/pip" install -q --upgrade pip
"$APP/.venv/bin/pip" install -q -r "$REPO/server/requirements.txt"
say "dependencies installed."

# --- 4. sync runtime code ----------------------------------------------------------------
# The sandboxed browser may only execute files under blessed locations, so a
# copy of the host + server code lives next to the venv. Re-run install.sh
# after every `git pull` to refresh it.
say "syncing runtime code…"
cp "$REPO/native/readit_host.py" "$APP/readit_host.py"
cp "$REPO/server/backends.py" "$REPO/server/tts_server.py" "$REPO/server/serve_kokoro.py" "$APP/server/"
cat > "$APP/readit_host.sh" <<EOF
#!/bin/bash
# Generated by install.sh — do not edit.
exec "$APP/.venv/bin/python" "$APP/readit_host.py" "\$@"
EOF
chmod +x "$APP/readit_host.sh" "$APP/readit_host.py"

# --- 5. native-messaging helper -------------------------------------------------------------
# NOTE: Comet reads manifests from the Google/Chrome directory, not its own —
# register everywhere; each browser only reads its own location.
say "registering the native helper…"
REGISTERED=0
for base in "${CANDIDATES[@]}"; do
  if [[ -d "$base" ]]; then
    dest="$base/NativeMessagingHosts"
    mkdir -p "$dest"
    # NOTE: the extension id is pinned by the "key" in extension/manifest.json,
    # so this origin is identical on every machine.
    cat > "$dest/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Read-It local MLX voice server helper",
  "path": "$APP/readit_host.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://dnpkdcbdccnpnmcojaemknfbnfkfkgld/"]
}
EOF
    say "registered for $(basename "$base")"
    REGISTERED=$((REGISTERED + 1))
  fi
done
[[ "$REGISTERED" -gt 0 ]] || warn "no Chromium browser profile found — the manifest will be registered on next run. (Supported: Chrome, Arc, Comet, Brave, Edge, Dia, Chromium.)"

# --- 6. optional weight prefetch ---------------------------------------------------------------
if [[ "$DOWNLOAD_NOW" -eq 1 ]]; then
  say "prefetching Kokoro weights (~0.7 GB)…"
  "$APP/.venv/bin/python" "$APP/readit_host.py" --download kokoro
  say "weights cached."
fi

# --- 7. next steps --------------------------------------------------------------------------------
echo
say "done. One manual step remains (browsers don't allow scripts to install extensions):"
echo "  1. Fully quit your browser once (so it picks up the new helper), then reopen it"
echo "  2. Open  chrome://extensions  (or equivalent), enable Developer mode"
echo "  3. Click “Load unpacked” and select:  $REPO/extension"
echo
say "Then click the Novel Reader icon → Open player. Voice, style, and the"
say "local server are all controlled inside the player — nothing else to set up."

# Best effort: open the extensions page in whatever Chromium browser exists.
for app in "Google Chrome" "Arc" "Comet" "Brave Browser" "Microsoft Edge" "Dia" "Chromium"; do
  if [[ -d "/Applications/$app.app" ]]; then
    open -a "$app" "chrome://extensions" 2>/dev/null || true
    say "opened chrome://extensions in $app for you."
    break
  fi
done
