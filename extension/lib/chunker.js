(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ReadItChunker = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const ABBREVIATIONS = new Set([
    'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'sr', 'jr', 'vs', 'etc', 'eg',
    'ie', 'cf', 'al', 'co', 'inc', 'ltd', 'corp', 'dept', 'no', 'fig',
    'vol', 'pp', 'p', 'ch', 'ed', 'est', 'approx', 'min', 'max', 'gen',
    'col', 'lt', 'cap', 'sen', 'rep', 'mt', 'ft', 'mi', 'km', 'cm', 'mm',
  ]);

  // Abbreviation written with internal dots: "e.g.", "i.e.", "U.S.", "a.m."
  const DOTTED_ABBREVIATIONS = new Set([
    'e.g', 'i.e', 'u.s', 'u.k', 'a.m', 'p.m', 'u.s.a', 'u.k', 'c.e.o',
  ]);

  function normalizeText(raw) {
    return String(raw == null ? '' : raw)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\u00a0\u2000-\u200b\u202f\u205f\u3000]+/g, ' ')
      .replace(/[\u00a0\u3000]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  const HANGUL = /[\uac00-\ud7af]/;
  const KANA = /[\u3040-\u30ff]/;

  const ENDERS = /[.!?\uFF01\uFF1F]/;
  const CJK_ENDERS = /[\u3002\uFF0E]/;
  const ELLIPSIS = /[\u2026\u22EF]/;

  function isClosingQuoteOrBracket(c) {
    return /[\u201D\u2019"'\uFF09)\u300D\u300F\u300B\u00BB\u3009\uFE65\]]/.test(c);
  }

  function tokenBefore(text, i) {
    let j = i - 1;
    while (j >= 0 && /[A-Za-z]/.test(text[j])) j--;
    return text.slice(j + 1, i).toLowerCase();
  }

function nextNonSpace(text, i) {
  let j = i + 1;
  while (j < text.length && /[\s\u2000-\u200f\u202f\u3000]/.test(text[j])) j++;
  return text[j];
}

// Is text[i] (a '.') the final dot of a dotted abbreviation such as "e.g."
// or "U.S."? Returns the matched abbreviation when true.
function dottedAbbrevAt(text, i) {
  const seg = text.slice(Math.max(0, i - 10), i);
  const m = /(?:[A-Za-z]{1,4}\.)+[A-Za-z]{1,4}$/.exec(seg);
  if (!m) return null;
  const tok = m[0].toLowerCase();
  if (DOTTED_ABBREVIATIONS.has(tok)) return tok;
  return null;
}

function isTerminatorAt(text, i) {
  const c = text[i];
  if (c === undefined) return false;
  if (CJK_ENDERS.test(c)) return true;
  if (ELLIPSIS.test(c)) {
    // A run of ellipsis marks counts as one terminator; only the last one ends.
    return !(text[i + 1] && ELLIPSIS.test(text[i + 1]));
  }
  if (!ENDERS.test(c)) return false;

  if (c === '.') {
    // Decimal: 3.14 -> never a terminator.
    if (i - 1 >= 0 && /\d/.test(text[i - 1]) && /\d/.test(text[i + 1] || '')) return false;
    // Domain-ish runs like "alibaba.com/read" -> not a terminator.
    if (
      i - 1 >= 0 && /[A-Za-z0-9]/.test(text[i - 1]) &&
      /[A-Za-z]/.test(text[i + 1] || '') &&
      /[A-Za-z]/.test(text[i + 2] || '')
    ) {
      return false;
    }
    const prev = text[i - 1] || '';
    if (/[A-Za-z]/.test(prev)) {
      if (dottedAbbrevAt(text, i)) return false;
      const tok = tokenBefore(text, i);
      if (ABBREVIATIONS.has(tok)) return false;
      // Single uppercase letter ending in '.' is usually an initial ("J. R. R.")
      if (tok.length === 1 && /[A-Z]/.test(prev)) return false;
      // "Hello. World" is a boundary; "Dr. smith" is not.
      const nextCh = nextNonSpace(text, i);
      if (nextCh && /[a-z]/.test(nextCh)) return false;
    }
    return true;
  }
  return true; // ! or ?
}

  function endAfterTerminator(text, i) {
    let j = i;
    while (j < text.length && /[.!?\uFF01\uFF1F\u3002\uFF0E\u2026\u22EF]/.test(text[j])) j++;
    while (j < text.length && isClosingQuoteOrBracket(text[j])) j++;
    return j;
  }

  function lastSplitIndex(text, start, maxLen) {
    const clauseEnders = /[,\uFF0C\u3001\uFF1B;:：;\u2014\u2026\u2015]/;
    let best = -1;
    for (let i = start + 1; i < start + maxLen && i < text.length; i++) {
      if (clauseEnders.test(text[i])) best = i + 1;
    }
    if (best < 0) {
      for (let i = start + Math.floor(maxLen * 0.6); i < start + maxLen && i < text.length; i++) {
        if (/\s/.test(text[i])) best = i + 1;
      }
    }
    return best;
  }

  /**
   * Split raw block text into sentence ranges. Offsets are relative to the
   * (unnormalized) input string so DOM text nodes can be highlighted
   * exactly. Whitespace around each sentence is trimmed from the range.
   *
   * opts:
   *  - maxLen: hard cap on sentence length in chars (default 160)
   */
  function splitTextRanges(raw, opts) {
    const o = opts || {};
    const maxLen = o.maxLen || 160;
    const text = String(raw == null ? '' : raw);

    const out = [];
    const push = (lineStart, s, e) => {
      while (s < e && /\s/.test(text[lineStart + s])) s++;
      while (e > s && /\s/.test(text[lineStart + e - 1])) e--;
      if (e <= s) return;
      out.push({ start: lineStart + s, end: lineStart + e, text: text.slice(lineStart + s, lineStart + e) });
    };

    let lineStart = 0;
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        let s = 0;
        let i = 0;
        while (i < line.length) {
          if (isTerminatorAt(line, i)) {
            let e = endAfterTerminator(line, i);
            while (e < line.length && /\s/.test(line[e])) e++;
            push(lineStart, s, e);
            s = e;
            i = e;
            continue;
          }
          i++;
          if (i - s > maxLen) {
            const sp = lastSplitIndex(line, s, maxLen);
            const cut = sp > 0 ? sp : s + maxLen;
            push(lineStart, s, cut);
            s = cut;
            i = cut;
          }
        }
        push(lineStart, s, line.length);
      }
      lineStart += line.length + 1;
    }
    return out;
  }

  function splitSentences(raw, opts) {
    return splitTextRanges(raw, opts).map((r) => r.text);
  }

  /**
   * Score a candidate DOM element as a reading container. (Browser only.)
   */
  function scoreCandidate(el, doc) {
    if (typeof doc === 'undefined') throw new Error('scoreCandidate needs a DOM');
    if (!el) return -Infinity;
    const g = doc.defaultView.getComputedStyle(el);
    if (g.display === 'none' || g.visibility === 'hidden') return -Infinity;

    const textLength = (el.textContent || '').replace(/\s+/g, ' ').length;
    if (textLength < 60) return -Infinity;

    const cls = ((el.className || '') + ' ' + (el.id || '')).toLowerCase();
    let score = textLength;
    if (/^(article|main|#?content)$|content|chapter|article|novel/i.test(cls)) score += 1200;
    else if (/main|reader|text|story-body|fic/i.test(cls)) score += 600;
    if (/nav|menu|footer|comment|sidebar|advert|related|recommend|breadcrumb|pagination|header|share|social/i.test(cls)) {
      score -= 20000;
    }

    let linkText = 0;
    for (const a of el.querySelectorAll('a')) linkText += (a.textContent || '').length;
    if (textLength > 0 && linkText / textLength > 0.5) score -= 30000;

    return score;
  }

  /**
   * Find the best reading container. (Browser only.)
   */
  function findArticleRoot(doc) {
    if (typeof doc === 'undefined') throw new Error('findArticleRoot needs a DOM');
    const candidates = [];
    const seen = new Set();
    const push = (el) => {
      if (el && el.nodeType === 1 && !seen.has(el)) {
        seen.add(el);
        candidates.push(el);
      }
    };

    const selectors = [
      'article', 'main', '[role="main"]',
      '#content', '.content', '.chapter-content', '.chapter', '.article-content',
      '#chaptercontent', '.pd_readchapter', '.reader-content', '.novel-content',
      '.read-content', '.fic-content', '.page-content',
    ];
    for (const sel of selectors) {
      for (const el of doc.querySelectorAll(sel)) push(el);
    }
    for (const el of doc.querySelectorAll('div,section,body')) push(el);

    const scored = candidates
      .map((el) => ({ el, score: scoreCandidate(el, doc) }))
      .filter((s) => s.score > -Infinity)
      .sort((a, b) => b.score - a.score);

    if (!scored.length) {
      let best = null;
      let bestLen = 0;
      for (const p of doc.querySelectorAll('p')) {
        const l = (p.textContent || '').length;
        if (l > bestLen) {
          bestLen = l;
          best = p.parentElement || p;
        }
      }
      return best;
    }
    return scored[0].el;
  }

  /**
   * Whether an element is navigation/sidebar/footer-style chrome. (Browser only.)
   */
  function isChrome(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (['script', 'style', 'noscript', 'template', 'iframe', 'form', 'select', 'input', 'button', 'nav', 'aside', 'footer', 'header', 'figure'].indexOf(tag) >= 0) {
      return true;
    }
    const cls = ((el.className || '') + ' ' + (el.id || '')).toLowerCase();
    return /nav|menu|footer|comment|sidebar|advert|\bad\b|related|recommend|breadcrumb|pagination|share|social/i.test(cls);
  }

  return {
    normalizeText,
    splitSentences,
    splitTextRanges,
    findArticleRoot,
    isChrome,
    scoreCandidate,
    CJK,
    HANGUL,
    KANA,
  };
});