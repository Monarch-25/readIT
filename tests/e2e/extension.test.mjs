/**
 * End-to-end test: load the real unpacked extension in Chromium, point it at
 * the mock vLLM-Omni TTS server, paste text into the player window, and drive
 * the new paste-and-read flow (popup settings -> player window -> real <audio>
 * playback of server-generated WAV).
 *
 * Requires a headed Chromium (Playwright) and the mock server module.
 * Run: npm run e2e
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start as startMock } from '../mock_server.mjs';
import { extensionLaunchArgs, discoverExtensionId } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXTENSION_PATH = path.join(ROOT, 'extension');

// Enough English prose to produce a couple of batch windows and let playback
// observably advance (splitSentences -> ~50 sentences).
const SAMPLE_TEXT = [
  'The lamps along Crown Street guttered to low amber, and the rain began again, soft and untroubled.',
  'Roland paused beneath the awning of a shuttered baker\u2019s shop and listened to the city settle into its night.',
  'Somewhere a drayman cursed a stuck wheel; somewhere a servant dropped a tray of brass buttons onto stone.',
  'None of it concerned him. He was expected at the Merchant\u2019s Oath by nine, and the summons had arrived in the same hand that had signed his late father\u2019s contracts.',
  'The tavern\u2019s sign creaked in the wind, a pair of crossed quills painted the colour of dried blood.',
  'He pushed the door open and the whole room turned to look at him.',
  'It was a room full of men who measured strangers the way a jeweller measured stones: by weight, by cut, by the likelihood of a flaw catching light at the wrong time.',
  'At the corner table a tall woman in grey kept her face in shadow and her wine untouched.',
  'The barkeep nodded at a booth near the stairs, and Roland went, leaving the eyes behind him like a tailor\u2019s chalk-marks.',
  'The man waiting in the booth had hands like dockworkers\u2019 tools and a coat that cost more than Roland\u2019s whole wardrobe.',
  '\u201cYou\u2019re late,\u201d said the man.',
  '\u201cYou\u2019re not the one who sent for me,\u201d Roland said, sitting down without being asked.',
  'The man\u2019s mouth tightened, then relaxed into something that was almost a smile.',
  '\u201cThey told me you were quick.\u201d',
  '\u201cThey tell everyone that.\u201d',
  'A bottle of the house brandy arrived, and two glasses, and the man poured without ceremony.',
  '\u201cYour father held a note,\u201d he said at last. \u201cA promissory note, signed by the Collector\u2019s own seal. It came due the night he died.\u201d',
  'Roland kept his face still. \u201cI know the note.\u201d',
  '\u201cThen you know it was never meant to be paid in coin.\u201d',
  'Outside, the rain found its rhythm against the window, and the room had gone quieter around them.',
  'The tall woman in grey had not moved, not even to drink.',
  'Roland looked at the brandy, at the man, at the whole crowded theatre of the ordinary, and understood that he was no longer an observer in it.',
  'Twelve chapters earlier, he had been a clerk who kept other people\u2019s ledgers.',
  'Now he kept other people\u2019s lives, whether the ledger liked it or not.',
  'He took up the glass.',
  '\u201cWhat does the Collector want?\u201d',
  '\u201cThe note says what it says. And the Collector is not a patient man, and his interest accrues.\u201d',
  '\u201cThen we had best not keep him waiting.\u201d',
  'The man in the good coat laughed, a short, dry sound like a key turning in a difficult lock.',
  '\u201cFollow me, then. The way is not through any door you\u2019d choose.\u201d',
  'They left by the kitchen, between hanging geese and mountains of sweating cheese, and out into an alley no wider than a man\u2019s outstretched arms.',
  'The woman in grey rose, folded her napkin once, and followed at a measured distance, her heels striking the stones like a metronome keeping time to someone else\u2019s song.',
].join('\n\n');

let mock;
let browserContext;
let userDataDir;
let popupPage;
let playerPage;
let extensionId;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function progressNumber(text) {
  if (!text) return -1;
  const m = /(\d+)\s*\/\s*\d+/.exec(text);
  return m ? Number(m[1]) : -1;
}

async function waitForText(page, selector, expected, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const text = await page.locator(selector).textContent({ timeout: 400 });
      const ok = typeof expected === 'function' ? expected(text) : (text || '').includes(expected);
      if (ok) return text;
    } catch {
      /* still loading */
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${selector} ${JSON.stringify(expected)}`);
}

async function pollExtensionId() {
  // No background service worker in this build, so determine the id via a
  // short probe launch whose Secure Preferences get flushed on close.
  return discoverExtensionId(EXTENSION_PATH);
}

function extensionUrl(pathname) {
  return `chrome-extension://${extensionId}/${pathname}`;
}

async function openPlayer() {
  const p = browserContext.waitForEvent('page');
  await popupPage.locator('#open').click();
  playerPage = await p;
  await playerPage.waitForLoadState('domcontentloaded');
  await playerPage.locator('#text').waitFor({ timeout: 10000 });
}

before(async () => {
  mock = await startMock({ log: false });
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-e2e-'));
  browserContext = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: extensionLaunchArgs(EXTENSION_PATH),
  });
  extensionId = await pollExtensionId();

  popupPage = await browserContext.newPage();
  await popupPage.goto(extensionUrl('popup/popup.html'));
  await popupPage.locator('#open').waitFor({ timeout: 10000 });
});

after(async () => {
  try {
    await browserContext.close();
  } catch {
    /* already closed */
  }
  try {
    await mock.stop();
  } catch {
    /* already stopped */
  }
});

test('popup opens the player and nothing else', async () => {
  await openPlayer();
  await playerPage.locator('#voiceSel').waitFor({ timeout: 10000 });
  // voice/style/language all live in the player now
  assert.ok(await playerPage.locator('#styleSel option').count() >= 6, 'expected style presets');
});

test('player window validates empty text', async () => {
  await playerPage.locator('#play').click();
  await waitForText(playerPage, '#status', 'Paste your chapter below', 5000);
});

test('upload a text file fills the editor', async () => {
  await playerPage.locator('#file').setInputFiles({
    name: 'chapter3.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('First line of the uploaded tale.\n\nSecond line of the uploaded tale.'),
  });
  await waitForText(playerPage, '#sourceName', 'chapter3.txt', 5000);
  const v = await playerPage.locator('#text').inputValue();
  assert.ok(v.includes('First line of the uploaded tale.'), 'textarea should hold the file text');
  const count = await playerPage.locator('#charCount').textContent();
  assert.ok(Number.parseInt(count, 10) > 20, `expected a char count, got ${count}`);
  await waitForText(playerPage, '#status', 'Loaded', 5000);
});

test('player connects a custom server and lists its voices', async () => {
  // no native helper in the test browser: the server row must degrade gracefully
  await waitForText(playerPage, '#srvText', 'helper missing', 10000);
  await playerPage.locator('#customLink').click();
  await playerPage.locator('#endpoint').fill(mock.baseUrl);
  await playerPage.locator('#probe').click();
  const deadline = Date.now() + 15000;
  let voiceCount = 0;
  while (Date.now() < deadline) {
    voiceCount = await playerPage.locator('#voiceSel option').count();
    if (voiceCount >= 9) break;
    await sleep(300);
  }
  assert.ok(voiceCount >= 9, `expected >= 9 voice options, got ${voiceCount}`);
});

test('pasted text is read via /v1/audio/speech/batch with correct payload', async () => {
  // narrator expressivity must travel to the server
  await playerPage.locator('#styleSel').selectOption('narrator');

  await playerPage.locator('#text').fill(SAMPLE_TEXT);
  await playerPage.locator('#play').click();

  const deadline = Date.now() + 20000;
  while (mock.getBatchRequests().length === 0 && Date.now() < deadline) await sleep(200);
  assert.ok(mock.getBatchRequests().length >= 1, 'no batch request received');

  const first = mock.getBatchRequests()[0].body;
  assert.ok(Array.isArray(first.items) && first.items.length === 4, `batch size should be 4, got ${first.items.length}`);
  assert.equal(first.voice, 'aiden');
  assert.equal(first.speed, 1.0);
  assert.equal(first.language, 'English');
  assert.equal(first.task_type, 'CustomVoice');
  assert.ok(String(first.instructions).includes('audiobook'), 'instructions should carry the preset text');

  // a second pipelined window should already be on its way (prefetch_target 8)
  const deadline2 = Date.now() + 10000;
  while (mock.getBatchRequests().length < 2 && Date.now() < deadline2) await sleep(200);
  assert.ok(mock.getBatchRequests().length >= 2, 'prefetch should have issued a second batch window');

  await waitForText(playerPage, '#state', (t) => (t || '').startsWith('Reading'), 30000);
});

test('now-reading spotlight tracks playback', async () => {
  await waitForText(playerPage, '#state', (t) => (t || '').startsWith('Reading'), 30000);
  await playerPage.locator('#transcript .sent.cur').waitFor({ timeout: 15000 });
  const now = await playerPage.locator('#now').textContent();
  assert.ok((now || '').trim().length > 10, 'expected the current sentence in the spotlight');
  const pos = await playerPage.locator('#progress').textContent();
  assert.match(pos || '', /\d+ \/ \d+/, `expected sentence position, got ${pos}`);
});

test('playback advances through the text', async () => {
  const startAt = progressNumber(await playerPage.locator('#progress').textContent());
  assert.ok(startAt >= 1, `expected position >= 1, got ${startAt}`);
  await waitForText(playerPage, '#progress', (t) => progressNumber(t) >= startAt + 2, 40000);
});

test('pause, resume and speed from the player', async () => {
  await waitForText(playerPage, '#state', (t) => (t || '').startsWith('Reading') || (t || '').startsWith('Finished'), 20000);
  if (((await playerPage.locator('#state').textContent()) || '').startsWith('Finished')) {
    await playerPage.locator('#play').click();
    await waitForText(playerPage, '#state', (t) => (t || '').startsWith('Reading'), 15000);
  }
  await playerPage.locator('#pause').click();
  await waitForText(playerPage, '#state', 'Paused', 10000);
  const pauseWord = await playerPage.locator('#pause').textContent();
  assert.equal((pauseWord || '').trim(), 'Resume');

  const frozen = await playerPage.locator('#progress').textContent();
  await sleep(1200);
  assert.equal(await playerPage.locator('#progress').textContent(), frozen, 'progress must not advance while paused');

  await playerPage.locator('#pause').click();
  await waitForText(playerPage, '#state', (t) => (t || '').startsWith('Reading'), 10000);

  await playerPage.locator('#speed').selectOption('1.3');
  const rate = await playerPage.evaluate(() => document.querySelector('audio').playbackRate);
  assert.equal(rate, 1.3);
});

test('stop resets the player', async () => {
  await waitForText(playerPage, '#state', (t) => (t || '').startsWith('Reading') || (t || '').startsWith('Finished'), 20000);
  if (((await playerPage.locator('#state').textContent()) || '').startsWith('Finished')) {
    await playerPage.locator('#play').click();
    await waitForText(playerPage, '#state', (t) => (t || '').startsWith('Reading'), 15000);
  }
  await playerPage.locator('#stop').click();
  await waitForText(playerPage, '#state', 'Stopped', 10000);
  const progress = await playerPage.locator('#progress').textContent();
  assert.ok(progressNumber(progress) < 1, `expected no position after stop, got ${progress}`);
});

test('color themes switch and persist', async () => {
  const themeOf = () => playerPage.evaluate(() => document.body.dataset.theme);
  const accentOf = () => playerPage.evaluate(() => getComputedStyle(document.body).getPropertyValue('--accent').trim());

  await playerPage.locator('.swatch[data-theme="paper"]').click();
  assert.equal(await themeOf(), 'paper');

  // choice survives a reload via chrome.storage
  await playerPage.reload();
  await playerPage.locator('#text').waitFor({ timeout: 10000 });
  assert.equal(await themeOf(), 'paper');

  // Martial Realm: cinnabar accent applied through CSS variables
  await playerPage.locator('.swatch[data-theme="martial"]').click();
  assert.equal(await themeOf(), 'martial');
  assert.equal(await accentOf(), '#e8533f');

  await playerPage.locator('.swatch[data-theme="ember"]').click();
  assert.equal(await themeOf(), 'ember');
});