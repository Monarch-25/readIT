/**
 * Live integration smoke test against the REAL MLX Kokoro-82M server.
 *
 * Skips unless a server is running and healthy (default 127.0.0.1:8902;
 * override with KOKORO_SERVER). Exercises the full flow: popup connect ->
 * open player window -> paste text -> real synthesis via
 * /v1/audio/speech/batch -> real playback in the player window.
 *
 * Run: KOKORO_SERVER=http://127.0.0.1:8902 node --test e2e/real_kokoro.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionLaunchArgs, discoverExtensionId } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXTENSION_PATH = path.join(ROOT, 'extension');
const SERVER = process.env.KOKORO_SERVER || 'http://127.0.0.1:8902';

const SAMPLE_TEXT = [
  'The lamps along the street guttered to low amber, and the rain began again, soft and untroubled.',
  'Roland paused beneath the awning of a shuttered shop and listened to the city settle into its night.',
  'He was expected at the tavern by nine, and the summons had arrived in the same hand that had signed his late father\u2019s contracts.',
  'Inside, the whole room turned to look at him.',
  'It was a room full of men who measured strangers the way a jeweller measured stones: by weight, by cut, by the chance of a flaw catching the light at the wrong time.',
  'At the corner table a tall woman in grey kept her face in shadow and her wine untouched.',
].join('\n\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probeHealth() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${SERVER}/healthz`, { signal: ctrl.signal });
    const j = await res.json();
    return { ok: j.ok === true, voices: j.voices, model: j.model };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(page, sel, pred, timeout = 25000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const text = await page.locator(sel).textContent({ timeout: 300 }).catch(() => '');
    if (pred(text)) return text;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${sel}: ${JSON.stringify(pred)}`);
    await sleep(500);
  }
}

let browserContext;
let popupPage;
let playerPage;

const liveHealth = await probeHealth();
if (liveHealth.ok) console.log(`# live Kokoro server healthy (${liveHealth.voices} voices) at ${SERVER}`);

after(async () => {
  try {
    await browserContext && browserContext.close();
  } catch {
    /* already closed */
  }
});

test('player reads pasted text with REAL Kokoro audio', { skip: !liveHealth.ok }, async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-kokoro-'));
  browserContext = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: extensionLaunchArgs(EXTENSION_PATH),
  });

  // No background service worker in this build -> discover via probe launch.
  const extId = await discoverExtensionId(EXTENSION_PATH);

  popupPage = await browserContext.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popupPage.locator('#open').waitFor({ timeout: 10000 });

  const p = browserContext.waitForEvent('page');
  await popupPage.locator('#open').click();
  playerPage = await p;
  await playerPage.waitForLoadState('domcontentloaded');
  await playerPage.locator('#text').waitFor({ timeout: 10000 });

  // No native helper in the test browser: connect via the custom endpoint row.
  await playerPage.locator('#customLink').click();
  await playerPage.locator('#endpoint').fill(SERVER);
  await playerPage.locator('#probe').click();
  const deadline = Date.now() + 30000;
  let voiceCount = 0;
  while (Date.now() < deadline) {
    voiceCount = await playerPage.locator('#voiceSel option').count();
    if (voiceCount >= liveHealth.voices) break;
    await sleep(400);
  }
  assert.ok(voiceCount >= liveHealth.voices, 'voice list should come from the real model');
  assert.ok(voiceCount >= 50, `expected Kokoro's ~54 presets, got ${voiceCount}`);

  // Deterministic voice: the reference A-grade American voice.
  await playerPage.locator('#voiceSel').selectOption('af_heart');
  assert.equal(await playerPage.locator('#voiceSel').inputValue(), 'af_heart');

  await playerPage.locator('#text').fill(SAMPLE_TEXT);
  await playerPage.locator('#play').click();

  // Real synthesis is slow; give the first batch a generous window.
  await waitFor(playerPage, '#state', (t) => (t || '').startsWith('Reading'), 180000);

  // Real audio must have loaded and be measurable, not a silent stub.
  const audioDur = await playerPage.evaluate(
    () => new Promise((resolve) => {
      const a = document.querySelector('audio');
      if (a && a.duration && Number.isFinite(a.duration) && a.duration > 0) return resolve(a.duration);
      const t0 = Date.now();
      const iv = setInterval(() => {
        const d = document.querySelector('audio');
        if (d && d.duration && Number.isFinite(d.duration) && d.duration > 0) {
          clearInterval(iv);
          resolve(d.duration);
        } else if (Date.now() - t0 > 20000) {
          clearInterval(iv);
          resolve(-1);
        }
      }, 300);
    }),
  );
  assert.ok(audioDur > 0.5, `expected real audio duration, got ${audioDur}`);

  const progress = () => playerPage.locator('#progress').textContent();
  const startAt = Number((/(\d+)\s*\/\s*\d+/.exec(await progress()) || [])[1] || 0);
  const limit = Date.now() + 30000;
  let advanced = false;
  while (Date.now() < limit) {
    const t = Number((/(\d+)\s*\/\s*\d+/.exec(await progress()) || [])[1] || 0);
    const time = await playerPage.evaluate(() => {
      const a = document.querySelector('audio');
      return a && a.currentTime ? a.currentTime : 0;
    });
    if (t > startAt || time > 1.5) { advanced = true; break; }
    await sleep(500);
  }
  assert.ok(advanced, 'real audio or sentence position did not advance within 30s');

  // pause / resume round-trip against the real server
  await waitFor(playerPage, '#state', (t) => (t || '').startsWith('Reading'), 15000);
  await playerPage.locator('#pause').click();
  await waitFor(playerPage, '#state', (t) => t === 'Paused', 15000);

  // stop resets the player
  await playerPage.locator('#pause').click();
  await waitFor(playerPage, '#state', (t) => (t || '').startsWith('Reading'), 15000);
  await playerPage.locator('#stop').click();
  await waitFor(playerPage, '#state', (t) => t === 'Stopped', 15000);
});
