import { test } from 'node:test';
import assert from 'node:assert/strict';
import chunkerPkg from '../../extension/lib/chunker.js';
import ttsapiPkg from '../../extension/lib/ttsapi.js';
const { splitSentences, splitTextRanges, normalizeText } = chunkerPkg;
const { normalizeEndpoint, speakPayload, batchPayload } = ttsapiPkg;

test('splitSentences: basic English', () => {
  assert.deepEqual(
    splitSentences('Hello world. How are you? I am fine!'),
    ['Hello world.', 'How are you?', 'I am fine!']
  );
});

test('splitSentences: CJK punctuation', () => {
  assert.deepEqual(
    splitSentences('他在山巅闭目而立。风声呼啸，剑气纵横！小和尚却笑了……'),
    ['他在山巅闭目而立。', '风声呼啸，剑气纵横！', '小和尚却笑了……']
  );
});

test('splitSentences: mixed EN/zh quotes attach to sentence', () => {
  assert.deepEqual(
    splitSentences('"Stand up!" he roared.'),
    ['"Stand up!"', 'he roared.']
  );
  assert.deepEqual(
    splitSentences('「站住！」他喝道。'),
    ['「站住！」', '他喝道。']
  );
});

test('splitSentences: abbreviations and decimals do NOT split', () => {
  const text = 'Dr. Smith lives at 12.5 miles from here, e.g. near the lake.';
  assert.deepEqual(splitSentences(text), [text]);
});

test('splitSentences: ellipsis runs stay together, clauses split', () => {
  assert.deepEqual(splitSentences('等他……然后……没了。'), ['等他……', '然后……', '没了。']);
});

test('splitSentences: dotted abbreviations do not split', () => {
  const text = 'I.e. it begins. E.g. apples, pears, a.m. hours.';
  assert.deepEqual(splitSentences(text), ['I.e. it begins.', 'E.g. apples, pears, a.m. hours.']);
});

test('splitSentences: initials in a name do not split', () => {
  assert.deepEqual(splitSentences('J. R. R. Tolkien wrote it.'),
    ['J. R. R. Tolkien wrote it.']);
});

test('splitSentences: newlines are hard boundaries', () => {
  assert.deepEqual(
    splitSentences('first line\nsecond line\n\nthird line'),
    ['first line', 'second line', 'third line']
  );
});

test('splitSentences: long run splits on clause boundary', () => {
  const long = '这是第一句，有逗号。'.repeat(40); // long CJK run w/o clause enders is artificially split
  const out = splitSentences(long, { maxLen: 60 });
  assert.ok(out.length > 1, 'long run should be split');
  assert.ok(out.every((s) => s.length <= 62), 'all sentences within ~maxLen');
});

test('splitSentences: end-of-string without terminator keeps text', () => {
  assert.deepEqual(splitSentences('He ran over the hill'), ['He ran over the hill']);
});

test('splitSentences: empty and whitespace-only input', () => {
  assert.deepEqual(splitSentences('   \n  '), []);
  assert.deepEqual(splitSentences(''), []);
});

test('splitTextRanges: offsets map to raw string exactly', () => {
  const raw = 'Hello world. How are you?';
  const ranges = splitTextRanges(raw);
  assert.equal(ranges.length, 2);
  assert.equal(raw.slice(ranges[0].start, ranges[0].end), 'Hello world.');
  assert.equal(raw.slice(ranges[1].start, ranges[1].end), 'How are you?');
});

test('splitTextRanges: whitespace padded sentence trims but offsets stay valid', () => {
  const raw = '   A dozen words here. And then more.   ';
  const ranges = splitTextRanges(raw);
  assert.equal(raw.slice(ranges[0].start, ranges[0].end), 'A dozen words here.');
  assert.equal(raw.slice(ranges[1].start, ranges[1].end), 'And then more.');
});

test('normalizeText collapses whitespace but keeps CJK adjacency', () => {
  assert.equal(normalizeText('a\t\tb\n\n\nc'), 'a b\n\nc');
  assert.equal(normalizeText('三千 世界'), '三千 世界');
});

test('normalizeEndpoint handles bare host:port and strips trailing slash', () => {
  assert.equal(normalizeEndpoint('localhost:8091'), 'http://localhost:8091');
  assert.equal(normalizeEndpoint('http://192.168.1.5:8091/'), 'http://192.168.1.5:8091');
  assert.equal(normalizeEndpoint('https://tts.example.com/audio/'), 'https://tts.example.com/audio');
  assert.equal(normalizeEndpoint(''), null);
  assert.equal(normalizeEndpoint('ftp://x'), null);
});

test('speakPayload: always sets wav format, speed 1.0, CustomVoice', () => {
  const p = speakPayload('Hello', { voice: 'vivian', language: 'zh' });
  assert.equal(p.input, 'Hello');
  assert.equal(p.response_format, 'wav');
  assert.equal(p.speed, 1.0);
  assert.equal(p.task_type, 'CustomVoice');
});

test('speakPayload: optional fields carried through', () => {
  const p = speakPayload('Hello', {
    voice: 'ryan',
    language: 'english',
    instructions: 'Speak with intensity, not melodrama',
    max_new_tokens: 4096,
  });
  assert.equal(p.voice, 'ryan');
  assert.equal(p.language, 'english');
  assert.equal(p.instructions, 'Speak with intensity, not melodrama');
  assert.equal(p.max_new_tokens, 4096);
});

test('batchPayload: flat items + batch-level defaults', () => {
  const p = batchPayload(['a', 'b'], { voice: 'serena', language: 'chinese', instructions: 'calm' });
  assert.equal(p.items.length, 2);
  assert.equal(p.voice, 'serena');
  assert.equal(p.language, 'chinese');
  assert.equal(p.instructions, 'calm');
  assert.deepEqual(p.items.map((i) => i.input), ['a', 'b']);
});

test('batchPayload: per-item overrides', () => {
  const p = batchPayload(['a', 'b'], { voice: 'serena' }, [{ voice: 'ryan' }, {}]);
  assert.equal(p.items[0].voice, 'ryan');
  assert.equal(p.items[1].voice, undefined);
});