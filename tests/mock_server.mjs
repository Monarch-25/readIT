/**
 * Mock vLLM-Omni TTS server.
 *
 * Faithfully mirrors the /v1/audio/speech, /v1/audio/speech/batch and
 * /v1/audio/voices contracts from the vLLM-Omni speech API docs, plus an
 * /reader.html fixture page so the extension can be exercised end-to-end.
 *
 * Audio is real, playable 24 kHz 16-bit WAV (sine tones) whose duration
 * scales with the input length, so <audio> playback actually runs.
 *
 * Usage:
 *   node mock_server.mjs [--port 8123]            # standalone (logs + prints port)
 *   import { start } from './mock_server.mjs';    # in-process for tests
 */
import http from 'node:http';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const VOICES = ['af_heart', 'af_bella', 'af_nova', 'af_sky', 'am_adam', 'am_michael', 'bf_emma', 'bf_isabella', 'bm_george', 'jf_alpha', 'zf_xiaobei', 'pf_dora'];

const SAMPLE_RATE = 24000;

function makeWav(durationSec, freq = 440) {
  const n = Math.max(1, Math.floor(durationSec * SAMPLE_RATE));
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const fade = Math.min(1, i / 200, (n - i) / 200);
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.35 * fade;
    data.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// Duration proportional to input length so E2E can observe progression
// while still finishing in usable time (~25-30s for the whole fixture).
function durationFor(input) {
  return 0.35 + Math.min(0.12 * input.length, 2.4);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function speakError(res, message, code = 400) {
  sendJson(res, code, {
    error: { message, type: code === 500 ? 'server_error' : 'BadRequestError', param: null, code },
  });
}

export async function start({ port = 0, fixture = null, log = false } = {}) {
  const requests = [];
  const record = (entry) => requests.push(entry);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const method = req.method;

    try {
      if (method === 'GET' && url.pathname === '/v1/audio/voices') {
        sendJson(res, 200, { voices: VOICES, uploaded_voices: [] });
        return;
      }

      if (method === 'GET' && url.pathname === '/reader.html') {
        const html = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reader.html'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/audio/speech') {
        const body = await readJsonBody(req);
        record({ kind: 'speech', body, at: Date.now() });
        if (log) console.log('[mock] /v1/audio/speech', JSON.stringify(body).slice(0, 200));
        if (!body.input || typeof body.input !== 'string' || !body.input.trim()) {
          return speakError(res, 'Input text cannot be empty');
        }
        if (body.speed && body.speed !== 1.0) return speakError(res, 'speed must be 1.0');
        const wav = makeWav(durationFor(body.input), 300 + (body.voice || 'vivian').length * 9 % 500);
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': wav.length,
          'x-vllm-omni-input-text-tokens': String(body.input.length),
          'x-vllm-omni-output-tokens': String(Math.floor(wav.length / 4000)),
        });
        res.end(wav);
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/audio/speech/batch') {
        const body = await readJsonBody(req);
        record({ kind: 'batch', body, at: Date.now() });
        if (log) console.log('[mock] /v1/audio/speech/batch items=' + (body.items || []).length);
        if (!Array.isArray(body.items)) return speakError(res, 'items must be an array');
        if (body.items.length > 32) return speakError(res, 'too many items');
        const results = [];
        for (let idx = 0; idx < body.items.length; idx++) {
          const it = body.items[idx];
          const input = (it && it.input) || '';
          if (!input.trim()) {
            results.push({ index: idx, status: 'error', error: 'Input text cannot be empty' });
            continue;
          }
          const wav = makeWav(durationFor(input), 300 + ((it.voice || body.voice || 'vivian').length * 9) % 500);
          results.push({
            index: idx,
            status: 'success',
            audio_data: wav.toString('base64'),
            media_type: 'audio/wav',
            usage: { input_tokens: input.length, output_tokens: Math.floor(wav.length / 4000), total_tokens: input.length + Math.floor(wav.length / 4000) },
          });
        }
        sendJson(res, 200, { id: 'speech-batch-' + randomBytes(4).toString('hex'), results, total: results.length, succeeded: results.filter((r) => r.status === 'success').length, failed: results.filter((r) => r.status !== 'success').length });
        return;
      }

      sendJson(res, 404, { error: { message: 'Not found: ' + url.pathname, type: 'NotFoundError', param: null, code: 404 } });
    } catch (err) {
      speakError(res, String(err && err.message || err), 500);
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;

  return {
    port: actualPort,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    requests,
    getSpeechRequests: () => requests.filter((r) => r.kind === 'speech'),
    getBatchRequests: () => requests.filter((r) => r.kind === 'batch'),
    stop: () => new Promise((res) => server.close(res)),
  };
}

// Standalone runner.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argPort = process.argv.indexOf('--port');
  const port = argPort > -1 ? Number(process.argv[argPort + 1]) : 0;
  const srv = await start({ port, log: true });
  console.log('MOCK_READY port=' + srv.port + ' url=' + srv.baseUrl);
  process.on('SIGINT', () => { srv.stop().then(() => process.exit(0)); });
}