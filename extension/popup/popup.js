/* The popup does one thing: open the player. Everything else lives there. */
(() => {
  'use strict';

  async function openPlayer() {
    try {
      await chrome.windows.create({
        url: chrome.runtime.getURL('player/player.html'),
        type: 'popup',
        width: 600,
        height: 780,
      });
    } catch (err) {
      document.getElementById('lede').textContent =
        'Could not open the player: ' + String(err && err.message || err);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('open').addEventListener('click', openPlayer);
  });
})();
