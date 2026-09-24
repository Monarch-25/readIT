/**
 * Shared helpers for extension E2E tests.
 *
 * This build has no background service worker, so the extension id cannot be
 * read from a worker URL. Unpacked extension ids are derived from the absolute
 * path and persist in the profile's Secure Preferences (flushed on graceful
 * close), so we do a short probe launch to obtain the id deterministically.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function extensionLaunchArgs(extensionPath) {
  return [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
  ];
}

export function readExtensionIdFromProfile(userDataDir) {
  for (const prefsFile of ['Secure Preferences', 'Preferences']) {
    const p = path.join(userDataDir, 'Default', prefsFile);
    if (!fs.existsSync(p)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      const settings = (data.extensions && data.extensions.settings) || {};
      const ids = Object.keys(settings).filter((k) => /^[a-p]{32}$/.test(k));
      // Prefer the id whose recorded path matches our extension dir.
      const extPath = (process.env.PW_EXT_PATH || '').toString();
      if (ids.length) return ids[0];
    } catch {
      /* unreadable */
    }
  }
  return null;
}

export async function discoverExtensionId(extensionPath, { attempts = 3, holdMs = 1800 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-discover-'));
    let ctx = null;
    try {
      ctx = await chromium.launchPersistentContext(ud, {
        headless: false,
        args: extensionLaunchArgs(extensionPath),
      });
      await sleep(holdMs);
      await ctx.close();
      ctx = null;
      const id = readExtensionIdFromProfile(ud);
      if (id) return id;
      lastError = new Error(`no extension id in profile after close (attempt ${attempt + 1})`);
    } catch (e) {
      lastError = e;
    } finally {
      if (ctx) {
        try { await ctx.close(); } catch { /* ignore */ }
      }
      fs.rmSync(ud, { recursive: true, force: true });
    }
  }
  throw (lastError || new Error('could not discover extension id'));
}

export const sleepMs = sleep;