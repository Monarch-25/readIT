// Novel Reader player window.
//
// Paste text (or upload a .txt/.md file, or drop one anywhere in the window)
// -> Play. The text is split into sentences and handed to the TTS server in
// pipelined batch windows; audio plays back sequentially in this window so it
// keeps running even when you're focused elsewhere. The sentence being read
// is spotlighted in the Now Reading card and lit up in the transcript below.
//
// Voice, style, language, and the local MLX server are all controlled here.
// Choices persist to chrome.storage.local; the popup only opens this window.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const chunker = self.ReadItChunker;
  const api = self.ReadItTtsApi;

  const DEFAULTS = {
    endpoint: '',
    voice: 'af_heart',
    language: 'English',
    instructions: '',
    speed: 1,
    batch_size: 4,
    prefetch_target: 8,
    max_new_tokens: 2048,
  };

  const MAX_FILE_BYTES = 5 * 1024 * 1024;

  const THEMES = [
    { id: 'ember', label: 'Ember (default)', sw: '#ffb545' },
    { id: 'ocean', label: 'Ocean', sw: '#5ec8f2' },
    { id: 'forest', label: 'Forest', sw: '#7be3a0' },
    { id: 'plum', label: 'Plum', sw: '#d99cff' },
    { id: 'martial', label: 'Martial Realm', sw: '#e8533f' },
    { id: 'paper', label: 'Paper (light)', sw: '#b3541e' },
  ];

  const state = {
    settings: { ...DEFAULTS },
    texts: [],        // sentence texts
    spans: [],        // transcript <span> per sentence
    tick: null,       // marginal marker that travels with the reading
    cur: -1,          // index of sentence currently playing
    queue: [],        // [{ i, url }] ready-to-play fragments
    nextToFetch: 0,
    inflight: false,
    seq: 0,
    status: 'idle',   // idle|buffering|playing|paused|done|error|stopped
    statusMsg: '',
    audio: null,
    objectUrls: [],
  };

  function decodeB64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function blobUrl(bytes, mediaType) {
    const blob = new Blob([bytes], { type: mediaType || 'audio/wav' });
    const url = URL.createObjectURL(blob);
    state.objectUrls.push(url);
    return url;
  }

  function revokeUrls() {
    for (const u of state.objectUrls) URL.revokeObjectURL(u);
    state.objectUrls = [];
  }

  function isBenignPlaybackError(err) {
    // Chrome rejects a pending play() promise when the src changes for the
    // next fragment; the new fragment's play() already ran, so not a failure.
    return !!(err && err.name === 'AbortError');
  }

  function settingsForRequest() {
    const s = state.settings;
    return {
      endpoint: s.endpoint,
      voice: s.voice,
      language: s.language,
      instructions: s.instructions,
      max_new_tokens: s.max_new_tokens,
    };
  }

  function buildTexts() {
    const raw = $('text').value;
    return chunker.splitSentences(raw).map((t) => t.trim()).filter((t) => t.length > 0);
  }

  function setStatus(s, msg) {
    state.status = s;
    state.statusMsg = msg || '';
    render();
  }

  async function requestBatch(fromSid, count) {
    const mySeq = ++state.seq; // uniquely owns this request; stop()/play() bump seq to invalidate it
    state.inflight = true;
    render();
    const items = state.texts.slice(fromSid, fromSid + count);
    const s = settingsForRequest();
    try {
      const payload = api.batchPayload(items, s);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 180000);
      const res = await fetch(s.endpoint + '/v1/audio/speech/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (mySeq !== state.seq) return; // superseded by stop/replay
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (!res.ok) {
        const msg = body && body.error && body.error.message ? body.error.message : 'HTTP ' + res.status;
        setStatus('error', 'Generation failed: ' + msg);
        return;
      }
      const results = (body && body.results) || [];
      for (const r of results) {
        if (!r || r.status !== 'success' || !r.audio_data) continue;
        const idx = fromSid + (r.index || 0);
        if (idx < 0 || idx >= state.texts.length) continue;
        state.queue.push({ i: idx, url: blobUrl(decodeB64(r.audio_data), r.media_type || 'audio/wav') });
      }
      state.queue.sort((a, b) => a.i - b.i);
      if (state.status === 'stopped') return;
      if (state.cur < 0 && state.status !== 'paused') processQueue();
      else render();
    } catch (err) {
      if (mySeq === state.seq) setStatus('error', 'Request failed: ' + String(err && err.message || err));
    } finally {
      // Only the request that still owns state.seq may clear the inflight gate;
      // otherwise it would clobber a newer window started by stop()/play().
      if (mySeq === state.seq) {
        state.inflight = false;
        ensureFetches();
      }
    }
  }

  function processQueue() {
    const next = state.queue.find((q) => q.i > state.cur);
    if (!next) {
      if (state.inflight || state.nextToFetch < state.texts.length) {
        if (state.status !== 'paused' && state.status !== 'stopped') setStatus('buffering', '');
        ensureFetches();
      } else {
        setStatus('done', '');
      }
      return;
    }
    state.queue = state.queue.filter((q) => q.i !== next.i);
    const a = state.audio;
    if (!a.paused) a.pause();
    a.src = next.url;
    a.currentTime = 0;
    a.playbackRate = state.settings.speed;
    state.cur = next.i;
    setStatus('playing', '');
    markCurrent();
    a.play().catch((err) => {
      if (isBenignPlaybackError(err)) return;
      if (err && err.name === 'NotAllowedError') setStatus('paused', 'Click Play in this window to let the audio start.');
      else setStatus('error', 'Playback: ' + String(err));
    });
    ensureFetches();
  }

  function ensureFetches() {
    if (state.inflight) return;
    if (state.status === 'stopped' || state.status === 'error') return;
    if (state.nextToFetch >= state.texts.length) return;
    const target = state.settings.prefetch_target || 2 * state.settings.batch_size;
    const buffered = state.queue.filter((q) => q.i > state.cur).length;
    const lead = state.cur < 0;
    if (lead || buffered < target) {
      const count = state.settings.batch_size || 4;
      requestBatch(state.nextToFetch, count);
      state.nextToFetch += count;
    }
  }

  async function play() {
    const data = await chrome.storage.local.get('ttsSettings');
    if (data && data.ttsSettings) {
      state.settings = { ...DEFAULTS, ...data.ttsSettings };
      summary();
    }
    const texts = buildTexts();
    if (!texts.length) {
      setStatus('error', 'Paste your chapter below, or open a file, first.');
      return;
    }
    if (!state.settings.endpoint) {
      setStatus('error', 'No server configured. Start Kokoro above, or connect a custom server.');
      return;
    }
    state.seq++;
    state.texts = texts;
    state.cur = -1;
    state.queue = [];
    state.nextToFetch = 0;
    state.inflight = false;
    revokeUrls();
    const a = state.audio;
    a.pause();
    a.removeAttribute('src');
    setTranscript(texts);
    collapseSource();
    setStatus('buffering', '');
    markCurrent();
    ensureFetches();
  }

  function pause() {
    if (state.status !== 'playing' && state.status !== 'buffering') return;
    if (state.audio && !state.audio.paused) state.audio.pause();
    setStatus('paused');
  }

  function resume() {
    if (state.status === 'done') {
      play();
      return;
    }
    if (state.status !== 'paused') return;
    setStatus('playing');
    if (state.audio && state.audio.getAttribute('src')) {
      state.audio.play().catch((err) => {
        if (isBenignPlaybackError(err)) return;
        if (err && err.name === 'NotAllowedError') setStatus('paused', 'Click Play in this window to let the audio start.');
        else setStatus('error', 'Playback: ' + String(err));
      });
      ensureFetches();
    } else {
      processQueue();
    }
  }

  function togglePause() {
    if (state.status === 'playing' || state.status === 'buffering') pause();
    else if (state.status === 'paused') resume();
    else if (state.status === 'done') play();
  }

  function stop() {
    state.seq++;
    state.status = 'stopped';
    if (state.audio) {
      state.audio.pause();
      state.audio.removeAttribute('src');
      state.audio.load();
    }
    revokeUrls();
    state.queue = [];
    state.cur = -1;
    state.nextToFetch = 0;
    state.inflight = false;
    markCurrent();
    render();
  }

  function setSpeed(v) {
    state.settings.speed = Number(v);
    if (state.audio) state.audio.playbackRate = Number(v);
    render();
  }

  // ---------- reading UI: spotlight + transcript ----------

  function setTranscript(texts) {
    const box = $('transcript');
    box.innerHTML = '';
    state.spans = texts.map((t) => {
      const sp = document.createElement('span');
      sp.className = 'sent';
      sp.textContent = t;
      box.appendChild(sp);
      box.appendChild(document.createTextNode(' '));
      return sp;
    });
    const tick = document.createElement('span');
    tick.id = 'tick';
    tick.setAttribute('aria-hidden', 'true');
    box.appendChild(tick);
    state.tick = tick;
  }

  function clearTranscript() {
    const box = $('transcript');
    box.innerHTML = '';
    const empty = document.createElement('p');
    empty.className = 'invitation';
    empty.textContent = 'Your chapter will appear here when you press Play — follow along as each sentence is read.';
    box.appendChild(empty);
    state.spans = [];
    state.tick = null;
  }

  function markCurrent() {
    for (let i = 0; i < state.spans.length; i++) {
      state.spans[i].classList.toggle('cur', i === state.cur);
    }
    const tick = state.tick;
    if (tick) {
      if (state.cur >= 0 && state.spans[state.cur]) {
        const sp = state.spans[state.cur];
        tick.style.top = (sp.offsetTop + 11) + 'px';
        tick.style.opacity = '1';
      } else {
        tick.style.opacity = '0';
      }
    }
    // Keep the sentence visible inside the chapter column only — the window
    // itself never scrolls for this.
    if (state.cur >= 0 && state.spans[state.cur] && $('follow').checked) {
      const box = $('transcript');
      const r = state.spans[state.cur].getBoundingClientRect();
      const b = box.getBoundingClientRect();
      if (r.top < b.top) box.scrollTop -= (b.top - r.top) + 10;
      else if (r.bottom > b.bottom) box.scrollTop += (r.bottom - b.bottom) + 10;
    }
  }

  function renderNow() {
    const total = state.texts.length;
    const prev = $('nowPrev');
    const cur = $('now');
    const next = $('nowNext');
    if (!total) {
      prev.textContent = '';
      cur.textContent = 'Paste your chapter below — or open a file — and I will read it aloud.';
      next.textContent = '';
      return;
    }
    if (state.cur < 0) {
      prev.textContent = '';
      cur.textContent = state.status === 'stopped'
        ? 'Stopped. Press Play to start over.'
        : 'The first sentence is on its way…';
      next.textContent = state.texts[0] || '';
      return;
    }
    prev.textContent = state.cur > 0 ? state.texts[state.cur - 1] : '';
    const text = state.texts[state.cur] || '';
    if (cur.textContent !== text) {
      cur.textContent = text;
      cur.classList.remove('swap');
      void cur.offsetWidth; // restart the arrival animation
      cur.classList.add('swap');
    }
    next.textContent = state.cur + 1 < total ? state.texts[state.cur + 1] : '';
  }

  function stateWord(s) {
    const total = state.texts.length;
    switch (s) {
      case 'playing': return state.cur >= 0 && total ? `Reading ${state.cur + 1} of ${total}` : 'Reading';
      case 'buffering': return 'Synthesizing…';
      case 'paused': return 'Paused';
      case 'done': return 'Finished — press Play to hear it again';
      case 'error': return 'Something went wrong';
      case 'stopped': return 'Stopped';
      default: return 'Ready';
    }
  }

  function render() {
    const s = state.status;
    const total = state.texts.length;

    const playBtn = $('play');
    const pauseBtn = $('pause');
    const stopBtn = $('stop');

    playBtn.textContent = total && s === 'done' ? 'Replay' : 'Play';
    playBtn.title = total && s === 'done' ? 'Replay from the start' : 'Start / restart reading';
    playBtn.disabled = s === 'playing' || s === 'buffering';
    pauseBtn.disabled = !(s === 'playing' || s === 'buffering' || s === 'paused' || s === 'done');
    pauseBtn.textContent = s === 'paused' ? 'Resume' : 'Pause';
    pauseBtn.title = s === 'paused' ? 'Resume' : 'Pause';
    stopBtn.disabled = s === 'idle' || s === 'stopped';

    $('speed').value = String(state.settings.speed);

    if (total) {
      const shown = state.cur >= 0 ? state.cur + 1 : 0;
      $('progress').textContent = `${shown} / ${total}`;
      $('progressFill').style.width = (shown / total) * 100 + '%';
    } else {
      $('progress').textContent = '– / –';
      $('progressFill').style.width = '0%';
    }

    // One quiet line of state; details and errors live in the message line.
    $('state').textContent = stateWord(s);

    const statusEl = $('status');
    statusEl.className = 'msgline' + (s === 'error' ? ' error' : '');
    statusEl.textContent = state.statusMsg || '';

    if (s === 'playing') startVoice();
    else stopVoice();

    renderNow();
  }

  function summary() {
    const s = state.settings;
    $('voiceName').textContent = s.voice || 'no voice';
  }

  // ---------- voice & server settings (owned by the player) ----------

  const HOST = 'com.readit.tts';
  const LOCAL_BACKEND = 'kokoro';
  const LOCAL_ENDPOINT = 'http://127.0.0.1:8902';

  const PRESETS = [
    { key: 'narrator', label: 'Narrator', text: 'Calm, measured audiobook narrator. Natural rhythm, subtle emotion, no overacting.' },
    { key: 'martial', label: 'Martial novel', text: 'Restrained but vivid martial-novel storyteller: terse, tense during fights, lyrical in stillness.' },
    { key: 'warm', label: 'Warm', text: 'Warm, intimate late-night storytelling voice, gentle and unhurried.' },
    { key: 'dramatic', label: 'Dramatic', text: 'Dramatic and cinematic, building intensity through each sentence.' },
    { key: 'wuxia', label: 'Wandering swordsman', text: 'Legendary wandering swordsman recounting a tale by the fire: lyrical, unhurried, faintly amused.' },
    { key: 'neutral', label: 'Plain', text: '' },
  ];

  let srvPoll = null;
  let srvMode = null; // 'download' | 'start' | 'stop' | null

  function sendNative(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendNativeMessage(HOST, msg, (resp) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: 'native-host-missing' });
          else resolve(resp || { ok: false, error: 'empty-response' });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err && err.message || err) });
      }
    });
  }

  function persist() {
    chrome.storage.local.set({ ttsSettings: { ...state.settings } });
  }

  function buildStyleSel() {
    const sel = $('styleSel');
    sel.innerHTML = '';
    for (const p of PRESETS) {
      const opt = document.createElement('option');
      opt.value = p.key;
      opt.textContent = p.label;
      sel.appendChild(opt);
    }
  }

  function matchStyle() {
    const sel = $('styleSel');
    const cur = (state.settings.instructions || '').trim();
    const hit = PRESETS.find((p) => p.text === cur);
    let custom = sel.querySelector('option[value="custom"]');
    if (custom) custom.remove();
    if (hit) {
      sel.value = hit.key;
    } else if (cur) {
      // Instructions predating the dropdown (e.g. typed in an older popup)
      // are kept verbatim rather than silently dropped.
      custom = document.createElement('option');
      custom.value = 'custom';
      custom.textContent = 'Custom';
      sel.appendChild(custom);
      sel.value = 'custom';
    } else {
      sel.value = 'neutral';
    }
  }

  function fillVoiceSel(list) {
    const sel = $('voiceSel');
    const voices = (list || []).map((v) => String(v)).filter(Boolean);
    const wanted = String(state.settings.voice || '').toLowerCase();
    sel.innerHTML = '';
    for (const v of voices) {
      const opt = document.createElement('option');
      opt.value = v.toLowerCase();
      opt.textContent = v;
      sel.appendChild(opt);
    }
    if (!voices.length) {
      const opt = document.createElement('option');
      opt.value = (state.settings.voice || 'af_heart').toLowerCase();
      opt.textContent = state.settings.voice || 'af_heart';
      sel.appendChild(opt);
    }
    if ([...sel.options].some((o) => o.value === wanted)) sel.value = wanted;
    else sel.selectedIndex = 0;
    state.settings.voice = sel.value;
    summary();
  }

  async function fetchVoices(endpoint) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(endpoint + '/v1/audio/voices', { signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      const list = Array.isArray(body) ? body
        : body && Array.isArray(body.voices) ? body.voices
        : body && body.data ? body.data
        : [];
      return list.map((v) => (typeof v === 'object' && v ? (v.voice_id || v.id || v.name) : v));
    } finally {
      clearTimeout(timer);
    }
  }

  async function probeEndpoint(ep) {
    const list = await fetchVoices(ep);
    state.settings.endpoint = ep;
    fillVoiceSel(list);
    persist();
    return list;
  }

  async function probeCustom() {
    const ep = api.normalizeEndpoint($('endpoint').value);
    if (!ep) {
      setStatus('error', 'That endpoint does not look like a URL — e.g. http://127.0.0.1:8901.');
      return;
    }
    $('probe').disabled = true;
    try {
      await probeEndpoint(ep);
      setStatus('idle', 'Connected. Pick a voice, then press Play.');
    } catch (err) {
      setStatus('error', 'Could not reach that server: ' + String(err && err.message || err));
    } finally {
      $('probe').disabled = false;
    }
  }

  function setSrv(text, cls, btnLabel) {
    $('srvText').textContent = text;
    $('srvDot').className = 'srvdot' + (cls ? ' ' + cls : '');
    const btn = $('srvBtn');
    if (btnLabel) {
      btn.hidden = false;
      btn.textContent = btnLabel;
      btn.disabled = btnLabel === '…' || btnLabel === 'Starting…';
    } else {
      btn.hidden = true;
    }
  }

  function startSrvPoll() {
    if (srvPoll) return;
    srvPoll = setInterval(() => refreshSrv(true), 2000);
  }

  function stopSrvPoll() {
    if (srvPoll) { clearInterval(srvPoll); srvPoll = null; }
  }

  async function refreshSrv(polling) {
    const resp = await sendNative({ cmd: 'status', backend: LOCAL_BACKEND });
    if (!resp || !resp.ok || resp.error === 'native-host-missing' || resp.error === 'empty-response') {
      setSrv('local helper missing — run install.sh', '');
      $('srvBtn').hidden = true;
      stopSrvPoll();
      return resp;
    }
    const srv = resp.server || {};
    const mod = resp.model || {};
    if (srv.running) {
      setSrv(`Kokoro · :${srv.port}${srv.adopted ? ' · adopted' : ''}`, 'ok', 'Stop');
      srvMode = 'stop';
    } else if (srv.starting) {
      setSrv('starting…', '', '…');
      srvMode = null;
    } else if (mod.downloading) {
      setSrv('fetching weights…', '', '…');
      srvMode = null;
    } else if (!mod.downloaded) {
      setSrv('weights needed · about 0.7 GB', 'err', 'Download');
      srvMode = 'download';
    } else {
      setSrv('Kokoro is stopped', '', 'Start');
      srvMode = 'start';
    }
    const busy = srv.starting || mod.downloading;
    if (busy && !polling) startSrvPoll();
    if (!busy && polling) stopSrvPoll();
    return resp;
  }

  async function srvAction() {
    if (srvMode === 'download') {
      setSrv('fetching weights…', '', '…');
      const resp = await sendNative({ cmd: 'download', backend: LOCAL_BACKEND });
      if (!resp || !resp.ok) setStatus('error', 'The download would not start: ' + String((resp && (resp.message || resp.error)) || 'unknown'));
      startSrvPoll();
      await refreshSrv();
    } else if (srvMode === 'start') {
      setSrv('starting…', '', '…');
      const resp = await sendNative({ cmd: 'start', backend: LOCAL_BACKEND });
      if (resp && resp.ok && resp.endpoint) {
        try {
          await probeEndpoint(resp.endpoint);
        } catch (err) {
          setStatus('error', 'The server started but its voices would not load: ' + String(err && err.message || err));
        }
      } else {
        setStatus('error', 'The server would not start: ' + String((resp && (resp.message || resp.error)) || 'unknown'));
      }
      await refreshSrv();
    } else if (srvMode === 'stop') {
      const resp = await sendNative({ cmd: 'stop', backend: LOCAL_BACKEND });
      if (resp && !resp.ok) setStatus('error', String(resp.message || resp.error || 'Stop failed.'));
      await refreshSrv();
    }
  }

  // ---------- source: upload / drop / clear / collapse ----------

  function fmtSize(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  function wordCount(text) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    return text.trim() ? words.length : 0;
  }

  function updateCount() {
    const raw = $('text').value;
    $('charCount').textContent = raw.length.toLocaleString() + ' chars';
    $('sourceLineCount').textContent = wordCount(raw).toLocaleString() + ' words';
  }

  function collapseSource() {
    $('sourceBody').hidden = true;
    $('sourceLine').hidden = false;
  }

  function expandSource() {
    $('sourceBody').hidden = false;
    $('sourceLine').hidden = true;
    $('text').focus();
  }

  function resetReading() {
    stop();
    state.texts = [];
    clearTranscript();
  }

  async function loadFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setStatus('error', `“${file.name}” is ${fmtSize(file.size)} — I can read files up to 5 MB.`);
      return;
    }
    let text = '';
    try {
      text = await file.text();
    } catch (err) {
      setStatus('error', 'I could not read that file: ' + String(err && err.message || err));
      return;
    }
    if (!text.trim()) {
      setStatus('error', `“${file.name}” is empty.`);
      return;
    }
    resetReading();
    $('text').value = text;
    $('sourceName').textContent = file.name;
    $('sourceLineName').textContent = file.name;
    updateCount();
    expandSource();
    render();
    setStatus('idle', `Loaded “${file.name}” — press Play.`);
  }

  function clearSource() {
    resetReading();
    $('text').value = '';
    $('sourceName').textContent = 'untitled';
    $('sourceLineName').textContent = 'untitled';
    updateCount();
    expandSource();
    render();
    setStatus('idle', 'Cleared. Paste a chapter or open a file.');
  }

  // ---------- voiceprint: the voice drawn live from the audio element ----------

  const voice = {
    ctx: null,
    actx: null,
    analyser: null,
    data: null,
    on: false,
    color: '#ffb545',
    faint: '#6e6350',
    reduced: !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
  };

  function voiceColors() {
    const cs = getComputedStyle(document.body);
    voice.color = cs.getPropertyValue('--accent').trim() || voice.color;
    voice.faint = cs.getPropertyValue('--faint').trim() || voice.faint;
  }

  function sizeVoiceCanvas() {
    const cv = $('voice');
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(cv.clientWidth * dpr));
    const h = Math.max(1, Math.floor(46 * dpr));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    return { w, h };
  }

  function drawFlat() {
    const cv = $('voice');
    if (!voice.ctx) voice.ctx = cv.getContext('2d');
    const { w, h } = sizeVoiceCanvas();
    const c = voice.ctx;
    c.clearRect(0, 0, w, h);
    c.strokeStyle = voice.faint;
    c.lineWidth = Math.max(1, window.devicePixelRatio || 1);
    c.beginPath();
    c.moveTo(0, h / 2);
    c.lineTo(w, h / 2);
    c.stroke();
  }

  function drawVoice() {
    if (!voice.on) return;
    const cv = $('voice');
    const { w, h } = sizeVoiceCanvas();
    const c = voice.ctx || (voice.ctx = cv.getContext('2d'));
    voice.analyser.getByteTimeDomainData(voice.data);
    const n = voice.data.length;
    const mid = h / 2;
    const amp = mid * 0.92;
    c.clearRect(0, 0, w, h);
    const trace = (width, alpha) => {
      c.strokeStyle = voice.color;
      c.globalAlpha = alpha;
      c.lineWidth = width;
      c.lineJoin = 'round';
      c.beginPath();
      const step = Math.max(1, Math.floor(n / w));
      let first = true;
      for (let i = 0; i < n; i += step) {
        const x = (i / n) * w;
        const y = mid + ((voice.data[i] - 128) / 128) * amp;
        if (first) { c.moveTo(x, y); first = false; }
        else c.lineTo(x, y);
      }
      c.stroke();
      c.globalAlpha = 1;
    };
    trace(Math.max(2, (window.devicePixelRatio || 1) * 3), 0.22);
    trace(Math.max(1, (window.devicePixelRatio || 1) * 1.2), 1);
    requestAnimationFrame(drawVoice);
  }

  function ensureAudioGraph() {
    if (voice.actx || voice.reduced) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      voice.actx = new AC();
      const src = voice.actx.createMediaElementSource(state.audio);
      voice.analyser = voice.actx.createAnalyser();
      voice.analyser.fftSize = 2048;
      voice.analyser.smoothingTimeConstant = 0.82;
      voice.data = new Uint8Array(voice.analyser.fftSize);
      src.connect(voice.analyser);
      voice.analyser.connect(voice.actx.destination);
    } catch {
      voice.actx = null;
    }
  }

  function startVoice() {
    voiceColors();
    if (voice.reduced || !voice.analyser && !voice.actx) ensureAudioGraph();
    if (voice.actx && voice.actx.state === 'suspended') voice.actx.resume().catch(() => {});
    if (voice.reduced || !voice.analyser) { drawFlat(); return; }
    if (!voice.on) {
      voice.on = true;
      requestAnimationFrame(drawVoice);
    }
  }

  function stopVoice() {
    voice.on = false;
    drawFlat();
  }

  async function loadSettings() {
    const data = await chrome.storage.local.get(['ttsSettings', 'readerTheme']);
    if (data && data.ttsSettings) state.settings = { ...DEFAULTS, ...data.ttsSettings };
    applyTheme(data && data.readerTheme, false);
    $('langSel').value = state.settings.language || 'English';
    buildStyleSel();
    matchStyle();
    fillVoiceSel([]); // stored voice stands in until a server answers
    summary();
    render();
    if (state.settings.endpoint) {
      try { await probeEndpoint(state.settings.endpoint); }
      catch { /* server offline; the server row says so */ }
      render();
    } else {
      // No endpoint yet — if the local server is already running, adopt it.
      const resp = await refreshSrv();
      const srv = resp && resp.server;
      if (srv && srv.running) {
        try { await probeEndpoint(LOCAL_ENDPOINT); } catch { /* row explains */ }
        render();
      }
    }
  }

  function applyTheme(id, persist = true) {
    const known = THEMES.some((t) => t.id === id);
    const theme = known ? id : 'ember';
    document.body.dataset.theme = theme;
    for (const el of document.querySelectorAll('#themes .swatch')) {
      el.classList.toggle('active', el.dataset.theme === theme);
    }
    voiceColors();
    if (!voice.on) drawFlat();
    if (persist) chrome.storage.local.set({ readerTheme: theme });
  }

  function buildThemes() {
    const box = $('themes');
    for (const t of THEMES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.dataset.theme = t.id;
      b.title = t.label;
      b.setAttribute('aria-label', 'Theme: ' + t.label);
      b.style.setProperty('--sw', t.sw);
      b.addEventListener('click', () => applyTheme(t.id));
      box.appendChild(b);
    }
  }

  function init() {
    state.audio = document.createElement('audio');
    state.audio.style.display = 'none';
    document.body.appendChild(state.audio);
    state.audio.addEventListener('ended', () => {
      if (state.status === 'stopped') return;
      processQueue();
    });
    state.audio.addEventListener('error', () => {
      if (state.status === 'stopped') return;
      setStatus('error', 'I could not play sentence ' + (state.cur + 1) + ' — its audio would not decode.');
    });

    $('play').addEventListener('click', () => { if (state.status !== 'playing' && state.status !== 'buffering') play(); });
    $('pause').addEventListener('click', togglePause);
    $('stop').addEventListener('click', stop);
    $('speed').addEventListener('change', (e) => setSpeed(e.target.value));

    $('voiceSel').addEventListener('change', (e) => {
      state.settings.voice = e.target.value;
      persist();
      summary();
    });
    $('styleSel').addEventListener('change', (e) => {
      const p = PRESETS.find((x) => x.key === e.target.value);
      if (p) state.settings.instructions = p.text;
      persist();
    });
    $('langSel').addEventListener('change', (e) => {
      state.settings.language = e.target.value;
      persist();
    });
    $('srvBtn').addEventListener('click', srvAction);
    $('customLink').addEventListener('click', () => {
      const row = $('customRow');
      row.hidden = !row.hidden;
      if (!row.hidden) $('endpoint').focus();
    });
    $('probe').addEventListener('click', probeCustom);
    $('endpoint').addEventListener('keydown', (e) => { if (e.key === 'Enter') probeCustom(); });
    window.addEventListener('unload', stopSrvPoll);

    $('text').addEventListener('input', updateCount);
    $('file').addEventListener('change', (e) => {
      loadFile(e.target.files && e.target.files[0]);
      e.target.value = ''; // allow re-uploading the same file
    });
    $('clear').addEventListener('click', clearSource);
    $('sourceLine').addEventListener('click', expandSource);

    // Drag & drop a text file anywhere in the window.
    let dragDepth = 0;
    const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      document.body.classList.add('dragover');
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (--dragDepth <= 0) {
        dragDepth = 0;
        document.body.classList.remove('dragover');
      }
    });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('dragover');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    updateCount();
    buildThemes();
    loadSettings();
    voiceColors();
    drawFlat();
    // One orchestrated entrance, then the page is live.
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('ready')));
  }

  document.addEventListener('DOMContentLoaded', init);
})();