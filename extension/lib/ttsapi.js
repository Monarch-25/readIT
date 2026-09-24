(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ReadItTtsApi = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const DEFAULT_VOICE = 'af_heart';
  const DEFAULT_LANGUAGE = 'English';
  const RESPONSE_FORMAT = 'wav';
  const MAX_NEW_TOKENS = 2048;

  /**
   * Normalize a user-supplied endpoint to "${origin}${basePath}" (no trailing
   * slash). Accepts "host:port" shorthand and URL-with-path (e.g. a reverse
   * proxy under /tts).
   */
  function normalizeEndpoint(raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return null;
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    let url;
    try {
      url = new URL(s);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    let base = url.origin + url.pathname.replace(/\/+$/, '');
    if (!base || base === url.origin) base = url.origin;
    return base;
  }

  /**
   * Body for POST /v1/audio/speech.
   */
  function speakPayload(input, settings) {
    const s = settings || {};
    const p = {
      input: input,
      response_format: s.response_format || RESPONSE_FORMAT,
      speed: 1.0,
    };
    if (s.model) p.model = s.model;
    if (s.voice) p.voice = s.voice; else p.voice = DEFAULT_VOICE;
    if (s.language) p.language = s.language;
    if (s.instructions) p.instructions = s.instructions;
    p.max_new_tokens = s.max_new_tokens || MAX_NEW_TOKENS;
    p.task_type = 'CustomVoice';
    return p;
  }

  /**
   * Body for POST /v1/audio/speech/batch.
   * items: array of text strings. settings provide batch-level defaults
   * (voice, language, instructions, ...) applied to every item; per-item
   * overrides (same keys) may be given for any item.
   */
  function batchPayload(items, settings, perItem) {
    const s = settings || {};
    const payload = {
      items: (items || []).map((it, i) => {
        const item = { input: it };
        const o = perItem && perItem[i] ? perItem[i] : null;
        if (o && o.voice) item.voice = o.voice;
        if (o && o.instructions) item.instructions = o.instructions;
        if (o && o.language) item.language = o.language;
        return item;
      }),
      voice: (s.voice || DEFAULT_VOICE),
      response_format: s.response_format || RESPONSE_FORMAT,
      language: s.language || DEFAULT_LANGUAGE,
      task_type: 'CustomVoice',
      speed: 1.0,
      instructions: s.instructions || '',
      max_new_tokens: s.max_new_tokens || MAX_NEW_TOKENS,
    };
    if (s.model) payload.model = s.model;
    return payload;
  }

  return {
    DEFAULT_VOICE,
    DEFAULT_LANGUAGE,
    RESPONSE_FORMAT,
    normalizeEndpoint,
    speakPayload,
    batchPayload,
  };
});