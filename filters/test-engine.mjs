#!/usr/bin/env node
/**
 * Quick end-to-end test for src/lib/adblock/engine.ts against the real built
 * list. Node 22.6+ strips TypeScript types natively (unflagged since 23.6), so
 * the .ts module is imported directly — no tsc, no npm dependencies.
 *
 *   node filters/build-filters.mjs      # produces filters/dist/filters.json
 *   node filters/test-engine.mjs        # runs the assertions below
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = resolve(ROOT, 'src/lib/adblock/engine.ts');
const LIST = process.argv[2] ? resolve(process.argv[2]) : resolve(ROOT, 'filters/dist/filters.json');

const { FilterEngine, isLikelyAdUrl, extractHostname } = await import(pathToFileURL(ENGINE).href);

const list = JSON.parse(await readFile(LIST, 'utf8'));
const t0 = performance.now();
const engine = new FilterEngine(list);
const buildMs = performance.now() - t0;
console.log(`list ${LIST}\nversion ${engine.version}, hosts ${engine.size.hosts}, patterns ${engine.size.patterns}, construction ${buildMs.toFixed(0)} ms`);

const cases = [
  ['https://doubleclick.net/x', true],
  ['https://ad.doubleclick.net/ddm/adj/N1234.foo/B5678;sz=300x250', true],
  ['https://www.youtube.com/api/stats/ads?x=1', true],
  ['https://www.youtube.com/pagead/adview', true],
  ['https://www.youtube.com/youtubei/v1/browse', false],
  ['https://i.ytimg.com/vi/abc/hq720.jpg', false],
  ['https://rr3---sn-xxx.googlevideo.com/videoplayback?expire=1&ei=abc&ip=1.2.3.4&id=o-xyz&itag=18', false],
  ['https://www.googletagmanager.com/gtm.js', true],
  ['https://alecat88.github.io/youtubemax-filters/filters.json', false],
  // a few extras
  ['https://www.youtube.com/youtubei/v1/log_event?alt=json', true],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', false],
  ['https://m.youtube.com/', false],
  ['https://yt3.ggpht.com/ytc/abc=s88-c-k-c0x00ffffff-no-rj', false],
  ['https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', true],
  ['https://www.google-analytics.com/collect?v=1', true],
  ['https://accounts.google.com/ServiceLogin', false],
  ['https://youtubei.googleapis.com/youtubei/v1/player?key=x', false],
];

let failed = 0;
for (const [url, expectBlocked] of cases) {
  const m = engine.match(url);
  const ok = m.blocked === expectBlocked;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${expectBlocked ? 'block' : 'allow'}  ${url}  ${m.reason ? `(${m.reason}: ${m.rule})` : ''}`);
}

// Built-in fallback (before any list is loaded)
assert.equal(isLikelyAdUrl('https://doubleclick.net/x'), true);
assert.equal(isLikelyAdUrl('https://www.youtube.com/api/stats/ads?x=1'), true);
assert.equal(isLikelyAdUrl('https://www.youtube.com/youtubei/v1/browse'), false);
assert.equal(isLikelyAdUrl('https://i.ytimg.com/vi/abc/hq720.jpg'), false);
assert.equal(isLikelyAdUrl('https://www.googletagmanager.com/gtm.js'), true);
console.log('PASS  isLikelyAdUrl built-ins');

// Hostname parser
assert.equal(extractHostname('https://user:pw@Www.Example.com:8443/p?q#f'), 'www.example.com');
assert.equal(extractHostname('//cdn.example.com/x.js'), 'cdn.example.com');
assert.equal(extractHostname('example.com/path'), 'example.com');
assert.equal(extractHostname('http://[::1]:8080/'), '::1');
assert.equal(extractHostname('data:text/plain,hello'), '');
console.log('PASS  extractHostname');

// Empty engine never blocks
assert.equal(FilterEngine.empty().shouldBlock('https://doubleclick.net/x'), false);
console.log('PASS  FilterEngine.empty()');

// Rough throughput
const sample = cases.map((c) => c[0]);
const t1 = performance.now();
const N = 2000;
for (let i = 0; i < N; i++) engine.shouldBlock(sample[i % sample.length]);
console.log(`throughput ~${((performance.now() - t1) / N * 1000).toFixed(0)} µs/url`);

if (failed) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}
console.log('\nall cases passed');
