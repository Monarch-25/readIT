# Read-It — listen to anything with local AI voices 🔊

Paste text (or drop a `.txt`/`.md` file) into a reader window and have it read
aloud — no page scraping, no highlighting. Voices run **on your Mac** via
Apple's MLX framework: **Kokoro-82M** (54 voices, excellent English) and
**Qwen3-TTS** (style instructions, strong Chinese). No terminal needed after
setup — the browser extension downloads the weights and starts/stops the
server itself. A GPU **vLLM** server works too, if you have one.

```
┌──────────────┐  native-msg   ┌────────────────┐  spawn/stop  ┌───────────────┐
│  Extension   │◄─────────────►│ readit_host.py │◄────────────►│ MLX server    │
│ popup/player │  stdio JSON   │ (no terminal)  │  subprocess  │ :8902 kokoro  │
└──────────────┘               └────────────────┘              │ :8901 qwen    │
       │                                                      └───────────────┘
       │ manual endpoint also possible ──► remote vLLM-Omni :8091 (GPU box)
```

## Requirements

| | |
|---|---|
| Mac | Apple Silicon **M2 / M3 / M4 / M5** (MLX does not run on Intel) |
| macOS | 13.5 or newer |
| Python | 3.10+ (`python3 --version`; 3.12 from python.org works) |
| Disk | ~4 GB free (venv + Kokoro weights ≈ 0.7 GB) |
| Browser | Chrome, Arc, Comet, Brave, Edge, Dia, or Chromium |

## One-step install

```bash
git clone <your-repo-url> read-it
cd read-it
./install.sh                 # venv + deps + browser helper registration
# …or prefetch the voice weights now instead of from the player later:
./install.sh --download
```

`install.sh` checks the platform, creates `.venv`, installs the Python stack,
and registers the native-messaging helper with every Chromium browser found on
your Mac. It then opens `chrome://extensions` for you.

## Load the extension (the one manual step)

Browsers don't let scripts install extensions, so this click-through is
unavoidable — it takes 30 seconds:

1. In `chrome://extensions` (or your browser's equivalent), enable
   **Developer mode** (toggle, top right).
2. Click **Load unpacked**.
3. Select the `extension/` folder inside this repo.
4. Click the puzzle icon in the toolbar and **pin Novel Reader**.

The extension id is pinned by the repo (`"key"` in `manifest.json`), so it is
identical on every machine — the native helper only talks to this exact id.

## First run (all inside the player)

1. Click the Novel Reader icon → **Open player**. The popup does nothing else.
2. In the player, under the running head: pick a **Voice**, a **Style**
   (Narrator, Martial novel, Warm, Dramatic, Wandering swordsman, Plain), and
   a Language. Choices save automatically.
3. If the voice server isn't running, the server line says so:
   **Download** fetches the Kokoro weights once (~0.7 GB, progress live),
   then **Start** launches the server and loads its voices. **Stop** shuts it
   down. (No helper installed? The line says so — use **custom server…**
   to point at any URL instead.)
4. Paste a chapter — or **Open a file** / drop one in — and press **Play**.

Your choices persist in `chrome.storage.local`: reopening the browser restores
endpoint, voice, style, theme, and server status without re-downloading
anything.

## Switching voices & backends

- **Kokoro voices**: the voice id picks the language — `af_*`/`am_*` American
  English, `bf_*`/`bm_*` British, `jf_*` Japanese, `zf_*`/`zm_*` Mandarin,
  plus Spanish, French, Hindi, Italian, Portuguese. `af_bella` is the usual
  runner-up to `af_heart`.
- **Qwen3-TTS** (style instructions + explicit language): run
  `./.venv/bin/python server/serve_mlx.py --port 8901` once, then in the
  player click **custom server…**, enter `http://127.0.0.1:8901` and
  **Connect**.
- Both MLX servers can run side by side (`:8901` Qwen, `:8902` Kokoro).

## Using a remote vLLM server (GPU box)

Any server implementing the vLLM-Omni speech API works — the player just needs
its URL (custom server…). The contract:

| Endpoint | |
|---|---|
| `GET /v1/audio/voices` | `{"voices": [...]}` |
| `POST /v1/audio/speech` | `{input, voice, language, instructions?, speed: 1.0}` → binary WAV |
| `POST /v1/audio/speech/batch` | `{items: [{input, …}], voice, …}` → `{results: [{index, status, audio_data}]}` |

To stand one up with vLLM-Omni on a CUDA machine:

```bash
git clone https://github.com/vllm-project/vllm-omni && cd vllm-omni
uv venv --python 3.12 && . .venv/bin/activate
uv pip install -e . --no-build-isolation   # pick the tag matching your vllm
MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice PORT=8091 \
  /path/to/read-it/server/serve_vllm.sh
```

Then paste `http://<gpu-host>:8091` into the player's **custom server…**
field and hit **Connect**. (`server/serve_vllm.sh` in this repo wraps the
`vllm serve` invocation; adjust `DEPLOY_CONFIG` to your vLLM-Omni version.)

## Configuration reference

| | default |
|---|---|
| Kokoro server | `http://127.0.0.1:8902` (`server/serve_kokoro.py`, model `mlx-community/Kokoro-82M-bf16`, voice `af_heart`) |
| Qwen server | `http://127.0.0.1:8901` (`server/serve_mlx.py`, voice `aiden`) |
| Runtime state | `logs/` — `<backend>.pid`, `<backend>.log`, `download.json` |
| Weights | Hugging Face cache (`~/.cache/huggingface`), shared with any manual runs |
| Extension state | `chrome.storage.local` (`ttsSettings`, `backend` snapshot, `readerTheme`) |

## Troubleshooting

- **“helper not found” in the player** — re-run `./install.sh` with the
  browser installed (it registers per detected browser). Then reopen the player.
- **Port already in use** — another server owns it; the helper adopts a
  healthy one automatically, otherwise `lsof -nP -iTCP:8902` to find the owner.
- **Download stuck at 0%** — check `logs/download.log`; usually network or HF
  rate limits. Re-click Download to retry (it resumes).
- **Server starts but synthesis fails** — tail `logs/kokoro.log`; first
  synthesis compiles the pipeline and is slower.
- **No sound** — the browser only allows audio after a gesture *in the player
  window*; click Play there once.
- **Intel Mac / old macOS** — MLX requires Apple Silicon + macOS 13.5+;
  `install.sh` refuses anything else. Use the remote-vLLM path instead.

## Uninstall

1. Remove the extension in `chrome://extensions`.
2. Delete the helper manifests:
   `rm ~/Library/Application\ Support/*/NativeMessagingHosts/com.readit.tts.json ~/Library/Application\ Support/*/*/NativeMessagingHosts/com.readit.tts.json`
   (only touches our file).
3. `rm -rf` this folder. Weights stay in `~/.cache/huggingface` (delete the
   `models--mlx-community--Kokoro*` dirs to reclaim ~0.7 GB).

## Developing & tests

```
cd tests && npm install
npm run unit            # sentence splitter + payload builders
npm run e2e             # Playwright: real extension vs mock vLLM-Omni server
npm run e2e:live        # same, against a real Qwen server on :8901
npm run e2e:live-kokoro # same, against a real Kokoro server on :8902
./../.venv/bin/python -m compileall ../server ../native   # python sanity
```

Layout: `extension/` (MV3, no build step) · `server/` (shared `tts_server.py`
+ `backends.py`, thin `serve_*.py` launchers) · `native/` (stdio helper +
download worker) · `tests/` (unit + mock/live E2E) · `install.sh`.
