#!/usr/bin/env node
/**
 * build-filters.mjs — compiles Brave's default ad-block filter lists into a
 * compact JSON consumed by src/lib/adblock/engine.ts.
 *
 * Node 22+ ESM, no npm dependencies (global fetch only).
 *
 * Usage:
 *   node filters/build-filters.mjs [--out <dir>] [--snapshot <path>] [--previous-url <url>]
 *
 *   --out <dir>          output directory (default: filters/dist)
 *   --snapshot <path>    additionally write a (possibly slimmed) copy of
 *                        filters.json to this path (bundled in the app)
 *   --previous-url <url> if <out>/filters.json does not exist (CI), fetch the
 *                        previously published filters.json from this URL so the
 *                        version string stays stable when the content hash is
 *                        unchanged
 *
 * Sources
 *   1. Brave's list catalog (https://raw.githubusercontent.com/brave/adblock-lists/master/list_catalog.json,
 *      which currently 404s, so we also try the real location in
 *      brave/adblock-resources/filter_lists/list_catalog.json). Every entry with
 *      `default_enabled: true` contributes its `sources[].url`.
 *   2. If no catalog can be fetched: a hard-coded fallback (EasyList,
 *      EasyPrivacy, uBlock filters/unbreak/privacy, Brave lists).
 *   3. Always: uBlock quick-fixes.txt (YouTube hot fixes live there).
 *
 * Compilation rules (see README.md for the long version)
 *   - comments, metadata and cosmetic rules are skipped, except cosmetic rules
 *     targeting youtube.com / www.youtube.com / m.youtube.com, kept verbatim in
 *     `ytCosmetic`
 *   - network rules are kept only when every `$option` is in ALLOWED_OPTIONS;
 *     rules with domain=/from=/to=, modifiers (redirect, removeparam, csp, ...),
 *     negated types (~xhr), unknown options or regex bodies are dropped and
 *     counted in `stats`
 *   - `||host^` / `||host` become `hosts` (or `hostExceptions` for `@@` rules);
 *     everything else becomes `patterns` / `patternExceptions`
 *   - host exceptions that would neutralise the built-in `ytExtra` hosts are
 *     dropped (they come from site-specific unbreak rules whose `domain=` scope
 *     we cannot honour)
 *
 * Snapshot policy (the copy bundled into the app via --snapshot)
 *   The full output is well under the 6 MB budget, so the snapshot is currently a
 *   byte-for-byte copy of filters.json. Should it ever exceed SNAPSHOT_MAX_BYTES
 *   the script slims it in two steps and records what it did in
 *   `snapshotPolicy`: (1) drop `ytCosmetic` and `patternExceptions`, then (2) cap
 *   `patterns` to those containing one of SNAPSHOT_PATTERN_KEYWORDS. Hosts are
 *   never trimmed. The published filters.json on GitHub Pages is always complete.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCHEMA = 1;
const FETCH_TIMEOUT_MS = 30_000;
const CONCURRENCY = 6;
const MIN_PATTERN_LENGTH = 6;
const SNAPSHOT_MAX_BYTES = 6 * 1024 * 1024;
const SNAPSHOT_PATTERN_KEYWORDS = [
  'youtube', 'google', 'yt', 'ad', 'track', 'analytics', 'pixel', 'beacon',
  'metric', 'telemetry', 'doubleclick',
];

const CATALOG_URLS = [
  'https://raw.githubusercontent.com/brave/adblock-lists/master/list_catalog.json',
  'https://raw.githubusercontent.com/brave/adblock-resources/master/filter_lists/list_catalog.json',
];

const FALLBACK_SOURCES = [
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2020.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2021.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2022.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2023.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2024.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2025.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2026.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-general.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resource-abuse.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/ubo-link-shorteners.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-unbreak.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-specific.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-unbreak.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-social.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-android-specific.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-ios-specific.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-sugarcoat.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-firstparty.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-firstparty-regional.txt',
];

const EXTRA_SOURCES = [
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt',
];

/** $options we can honour (or safely ignore) in a mobile WebView interceptor. */
const ALLOWED_OPTIONS = new Set([
  'important', 'third-party', '3p', 'xmlhttprequest', 'xhr', 'script', 'image',
  'media', 'subdocument', 'frame', 'ping', 'other', 'font', 'stylesheet', 'css',
  'object', 'websocket', 'document', 'doc', 'popup',
]);

/** Options we recognise but deliberately drop (counted as droppedUnsupportedOption). */
const UNSUPPORTED_OPTIONS = new Set([
  '1p', 'first-party', 'match-case', 'badfilter', 'generichide', 'ghide',
  'genericblock', 'elemhide', 'ehide', 'specifichide', 'shide', 'all',
  'redirect', 'redirect-rule', 'removeparam', 'csp', 'replace', 'header',
  'denyallow', 'inline-script', 'inline-font', 'popunder', 'strict1p',
  'strict3p', 'cname', 'empty', 'mp4', 'permissions', 'urltransform',
  'ipaddress', 'method', 'to', 'from', 'domain', 'uritransform', 'reason',
  'urlskip', 'rewrite', 'tag',
]);

const YT_COSMETIC_DOMAINS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);

/** Built-in rules so the app blocks YouTube ad/tracking endpoints even if the public lists change. */
const YT_EXTRA = {
  hosts: [
    'doubleclick.net',
    'googleadservices.com',
    'googlesyndication.com',
    'google-analytics.com',
    'googletagmanager.com',
    'googletagservices.com',
    'adservice.google.com',
    'pagead2.googlesyndication.com',
    'ads.youtube.com',
    'youtube.cleverads.vn',
    's0.2mdn.net',
    'static.doubleclick.net',
  ],
  patterns: [
    'youtube.com/pagead/',
    'youtube.com/ptracking',
    'youtube.com/api/stats/ads',
    'youtube.com/api/stats/qoe',
    'youtube.com/get_midroll_',
    'youtube.com/csi_204',
    'youtube.com/generate_204',
    'youtube.com/youtubei/v1/log_event',
    'youtube.com/youtubei/v1/att/',
    'googlevideo.com/videogoodput',
    'youtube.com/api/stats/atr',
    'youtube.com/pcs/activeview',
    'play.google.com/log',
  ],
};

/** Hosts the app itself needs. Host rules never apply to them; patterns still do. */
const NEVER_BLOCK_HOSTS = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtubei.googleapis.com',
  'i.ytimg.com',
  'i9.ytimg.com',
  'yt3.ggpht.com',
  'yt3.googleusercontent.com',
  'googlevideo.com',
  'accounts.google.com',
  'ssl.gstatic.com',
  'www.gstatic.com',
  'fonts.gstatic.com',
  'lh3.googleusercontent.com',
  'suggestqueries.google.com',
  'suggestqueries-clients6.youtube.com',
  'alecat88.github.io',
  'raw.githubusercontent.com',
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { out: resolve(REPO_ROOT, 'filters/dist'), snapshot: null, previousUrl: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = resolve(argv[++i]);
    else if (a === '--snapshot') args.snapshot = resolve(argv[++i]);
    else if (a === '--previous-url') args.previousUrl = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('usage: node filters/build-filters.mjs [--out <dir>] [--snapshot <path>] [--previous-url <url>]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchText(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'YouTubeMax-filters-builder/1 (+https://github.com/LaughTechnologies/YouTubeMax)' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function loadCatalogSources() {
  for (const url of CATALOG_URLS) {
    try {
      const catalog = JSON.parse(await fetchText(url));
      if (!Array.isArray(catalog)) throw new Error('catalog is not an array');
      const urls = [];
      const titles = [];
      for (const entry of catalog) {
        if (entry?.default_enabled !== true) continue;
        titles.push(entry.title ?? entry.uuid ?? '?');
        for (const s of entry.sources ?? []) if (typeof s?.url === 'string') urls.push(s.url);
      }
      if (urls.length === 0) throw new Error('no default-enabled sources');
      return { urls, catalogUrl: url, lists: titles };
    } catch (err) {
      console.warn(`catalog ${url}: ${err.message} (trying next)`);
    }
  }
  return { urls: FALLBACK_SOURCES, catalogUrl: null, lists: ['<hard-coded fallback>'] };
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const COSMETIC_RE = /^([^#]*?)#(@?)([?$%]{0,2})#/;
const HOST_RULE_RE = /^\|\|([a-z0-9\u00a1-\uffff_][a-z0-9\u00a1-\uffff_-]*(?:\.[a-z0-9\u00a1-\uffff_-]+)+\.?)\^?$/i;
const TLD_JUNK_RE = /^[|]*\.?[a-z0-9-]{1,6}\^?[|]*$/i;

function newStats() {
  return {
    lines: 0,
    comments: 0,
    cosmeticSkipped: 0,
    ytCosmetic: 0,
    networkRules: 0,
    hosts: 0,
    hostExceptions: 0,
    patterns: 0,
    patternExceptions: 0,
    droppedDomainOption: 0,
    droppedNegatedOption: 0,
    droppedUnsupportedOption: 0,
    droppedUnknownOption: 0,
    droppedRegex: 0,
    droppedShortPattern: 0,
    droppedJunkPattern: 0,
  };
}

/** Returns { keep: true } or { keep: false, why: statKey }. */
function classifyOptions(optionText) {
  if (optionText === '') return { keep: true };
  for (let opt of optionText.split(',')) {
    opt = opt.trim().toLowerCase();
    if (opt === '') continue;
    if (opt.startsWith('~')) return { keep: false, why: 'droppedNegatedOption' };
    const eq = opt.indexOf('=');
    if (eq !== -1) {
      const name = opt.slice(0, eq);
      if (name === 'domain' || name === 'from' || name === 'to') return { keep: false, why: 'droppedDomainOption' };
      return { keep: false, why: UNSUPPORTED_OPTIONS.has(name) ? 'droppedUnsupportedOption' : 'droppedUnknownOption' };
    }
    if (ALLOWED_OPTIONS.has(opt)) continue;
    return { keep: false, why: UNSUPPORTED_OPTIONS.has(opt) ? 'droppedUnsupportedOption' : 'droppedUnknownOption' };
  }
  return { keep: true };
}

function isJunkPattern(p) {
  if (TLD_JUNK_RE.test(p)) return true;
  const alnum = p.replace(/[^a-z0-9]/gi, '');
  return alnum.length < 3;
}

/**
 * Parse one filter list into the accumulator sets.
 * @returns number of rules contributed by this source (hosts+patterns+exceptions+ytCosmetic)
 */
function parseList(text, acc, stats) {
  let contributed = 0;
  for (let raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    stats.lines++;
    if (line === '' || line.startsWith('!') || line.startsWith('[')) {
      stats.comments++;
      continue;
    }

    // Cosmetic / scriptlet rules
    const cm = COSMETIC_RE.exec(line);
    if (cm) {
      const domains = cm[1].split(',').map((d) => d.trim().toLowerCase());
      const targetsYt = domains.some((d) => YT_COSMETIC_DOMAINS.has(d));
      if (targetsYt) {
        if (!acc.ytCosmetic.has(line)) {
          acc.ytCosmetic.add(line);
          stats.ytCosmetic++;
          contributed++;
        }
      } else {
        stats.cosmeticSkipped++;
      }
      continue;
    }

    // Network rules
    stats.networkRules++;
    let body = line;
    let exception = false;
    if (body.startsWith('@@')) {
      exception = true;
      body = body.slice(2);
    }

    let options = '';
    const dollar = body.lastIndexOf('$');
    if (dollar > 0) {
      options = body.slice(dollar + 1);
      body = body.slice(0, dollar);
    } else if (dollar === 0) {
      // "$ping,3p" style rule with empty body — nothing to match on
      stats.droppedShortPattern++;
      continue;
    }
    body = body.trim();

    // Regex rules: /.../ (ABP treats a body that starts and ends with "/" as a regex)
    if (body.length > 2 && body.startsWith('/') && body.endsWith('/')) {
      stats.droppedRegex++;
      continue;
    }

    const verdict = classifyOptions(options);
    if (!verdict.keep) {
      stats[verdict.why]++;
      continue;
    }

    const hm = HOST_RULE_RE.exec(body);
    if (hm) {
      const host = hm[1].toLowerCase().replace(/\.+$/, '');
      const set = exception ? acc.hostExceptions : acc.hosts;
      if (!set.has(host)) {
        set.add(host);
        stats[exception ? 'hostExceptions' : 'hosts']++;
        contributed++;
      }
      continue;
    }

    if (body.length < MIN_PATTERN_LENGTH) {
      stats.droppedShortPattern++;
      continue;
    }
    if (isJunkPattern(body)) {
      stats.droppedJunkPattern++;
      continue;
    }
    const set = exception ? acc.patternExceptions : acc.patterns;
    if (!set.has(body)) {
      set.add(body);
      stats[exception ? 'patternExceptions' : 'patterns']++;
      contributed++;
    }
  }
  return contributed;
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

function isHostOrParent(host, candidate) {
  return host === candidate || host.endsWith('.' + candidate);
}

/** Remove hosts whose parent domain is already in the set (engine matches parents). */
function pruneRedundantHosts(hostSet) {
  const kept = [];
  let pruned = 0;
  for (const h of hostSet) {
    let redundant = false;
    let idx = h.indexOf('.');
    while (idx !== -1) {
      if (hostSet.has(h.slice(idx + 1))) { redundant = true; break; }
      idx = h.indexOf('.', idx + 1);
    }
    if (redundant) pruned++;
    else kept.push(h);
  }
  return { kept, pruned };
}

function sortStrings(arr) {
  return [...arr].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function contentHash(parts) {
  const h = createHash('sha256');
  for (const [name, list] of Object.entries(parts)) {
    h.update(name + '\n');
    for (const item of list) h.update(item + '\n');
  }
  return h.digest('hex');
}

function timestampVersion(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function readPrevious(outFile, previousUrl) {
  try {
    const prev = JSON.parse(await readFile(outFile, 'utf8'));
    if (prev && typeof prev.version === 'string') return { from: outFile, ...prev };
  } catch { /* no local previous build */ }
  if (previousUrl) {
    try {
      const prev = JSON.parse(await fetchText(previousUrl, 20_000));
      if (prev && typeof prev.version === 'string') return { from: previousUrl, ...prev };
    } catch (err) {
      console.warn(`previous ${previousUrl}: ${err.message}`);
    }
  }
  return null;
}

function slimForSnapshot(list) {
  let snap = { ...list };
  let json = JSON.stringify(snap);
  const policy = [];
  if (Buffer.byteLength(json) > SNAPSHOT_MAX_BYTES) {
    snap = { ...snap, ytCosmetic: [], patternExceptions: [] };
    policy.push('dropped ytCosmetic and patternExceptions');
    json = JSON.stringify(snap);
  }
  if (Buffer.byteLength(json) > SNAPSHOT_MAX_BYTES) {
    const kw = SNAPSHOT_PATTERN_KEYWORDS;
    snap = { ...snap, patterns: snap.patterns.filter((p) => { const l = p.toLowerCase(); return kw.some((k) => l.includes(k)); }) };
    policy.push(`capped patterns to those containing: ${kw.join(', ')}`);
    json = JSON.stringify(snap);
  }
  if (policy.length) snap.snapshotPolicy = policy;
  return { snap, json: JSON.stringify(snap), policy };
}

const INDEX_HTML = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>YouTubeMax ad filters</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#222}code{background:#f3f3f3;padding:.1em .3em;border-radius:3px}</style>
<h1>YouTubeMax ad filters</h1>
<p>Compiled ad/tracker block list for the YouTubeMax client, built from Brave's default filter lists
(EasyList, EasyPrivacy, uBlock Origin filters, Brave lists) every 6 hours by GitHub Actions.</p>
<ul>
<li><a href="filters.json">filters.json</a> — the full list (hosts, patterns, exceptions)</li>
<li><a href="version.json">version.json</a> — tiny manifest the app polls to see if a new build exists</li>
</ul>
<p>Source: <a href="https://github.com/LaughTechnologies/YouTubeMax">github.com/LaughTechnologies/YouTubeMax</a> (<code>filters/build-filters.mjs</code>).</p>
`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();

  const catalog = await loadCatalogSources();
  const sourceUrls = [...new Set([...catalog.urls, ...EXTRA_SOURCES])];
  console.log(
    catalog.catalogUrl
      ? `catalog: ${catalog.catalogUrl}\nlists: ${catalog.lists.join(' | ')}`
      : 'catalog: unavailable, using hard-coded fallback sources',
  );
  console.log(`sources: ${sourceUrls.length}`);

  const acc = {
    hosts: new Set(),
    hostExceptions: new Set(),
    patterns: new Set(),
    patternExceptions: new Set(),
    ytCosmetic: new Set(),
  };
  const stats = newStats();

  // Download everything first (parallel), then parse in a stable order so the
  // output does not depend on which download finished first.
  const downloads = await mapWithConcurrency(sourceUrls, CONCURRENCY, async (url) => {
    const t0 = Date.now();
    try {
      const text = await fetchText(url);
      console.log(`  ok   ${url} (${(text.length / 1024).toFixed(0)} KB, ${Date.now() - t0} ms)`);
      return { url, ok: true, text };
    } catch (err) {
      console.warn(`  FAIL ${url}: ${err.message}`);
      return { url, ok: false, error: err.message };
    }
  });

  const sources = downloads.map((d) => {
    if (!d.ok) return { url: d.url, ok: false, rules: 0, error: d.error };
    const rules = parseList(d.text, acc, stats);
    return { url: d.url, ok: true, rules };
  });

  // Built-in YouTube extras
  for (const h of YT_EXTRA.hosts) acc.hosts.add(h);
  for (const p of YT_EXTRA.patterns) acc.patterns.add(p);

  // Exceptions that would neutralise the built-ins (they come from unbreak lists
  // whose domain= scope we had to drop) are removed.
  let exceptionsDroppedForYtExtra = 0;
  for (const ex of [...acc.hostExceptions]) {
    const clashes = YT_EXTRA.hosts.some((h) => isHostOrParent(h, ex) || isHostOrParent(ex, h));
    if (clashes) { acc.hostExceptions.delete(ex); exceptionsDroppedForYtExtra++; }
  }

  const ytExtraPatterns = YT_EXTRA.patterns.map((p) => p.toLowerCase());
  for (const ex of [...acc.patternExceptions]) {
    const norm = ex.toLowerCase().replace(/^\|\|?/, '').replace(/[|^]$/, '');
    const clashes = ytExtraPatterns.some((p) => norm.includes(p) || p.includes(norm));
    if (clashes) { acc.patternExceptions.delete(ex); exceptionsDroppedForYtExtra++; }
  }

  const { kept: hosts, pruned: hostsPrunedRedundant } = pruneRedundantHosts(acc.hosts);
  const hostExceptions = sortStrings(acc.hostExceptions);
  const patterns = sortStrings(acc.patterns);
  const patternExceptions = sortStrings(acc.patternExceptions);
  const ytCosmetic = sortStrings(acc.ytCosmetic);
  const sortedHosts = sortStrings(hosts);

  const hash = contentHash({
    neverBlockHosts: NEVER_BLOCK_HOSTS,
    hosts: sortedHosts,
    hostExceptions,
    patterns,
    patternExceptions,
    ytCosmetic,
  });
  const hash8 = hash.slice(0, 8);

  const outDir = args.out;
  const outFile = resolve(outDir, 'filters.json');
  const previous = await readPrevious(outFile, args.previousUrl);
  const now = new Date();
  let version = `${timestampVersion(now)}-${hash8}`;
  let generatedAt = now.toISOString();
  let unchanged = false;
  if (previous && previous.version.endsWith('-' + hash8) && previous.contentHash === hash) {
    version = previous.version;
    generatedAt = previous.generatedAt ?? generatedAt;
    unchanged = true;
  }

  const finalStats = {
    ...stats,
    hosts: sortedHosts.length,
    hostExceptions: hostExceptions.length,
    patterns: patterns.length,
    patternExceptions: patternExceptions.length,
    ytCosmetic: ytCosmetic.length,
    hostsPrunedRedundant,
    exceptionsDroppedForYtExtra,
    sourcesOk: sources.filter((s) => s.ok).length,
    sourcesFailed: sources.filter((s) => !s.ok).length,
  };

  const list = {
    schema: SCHEMA,
    version,
    generatedAt,
    contentHash: hash,
    sources,
    stats: finalStats,
    neverBlockHosts: NEVER_BLOCK_HOSTS,
    ytExtra: YT_EXTRA,
    hosts: sortedHosts,
    hostExceptions,
    patterns,
    patternExceptions,
    ytCosmetic,
  };

  const filtersJson = JSON.stringify(list);
  const bytes = Buffer.byteLength(filtersJson);
  const versionJson = JSON.stringify({
    version,
    generatedAt,
    bytes,
    hosts: sortedHosts.length,
    patterns: patterns.length,
  }, null, 2) + '\n';

  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, filtersJson);
  await writeFile(resolve(outDir, 'version.json'), versionJson);
  await writeFile(resolve(outDir, 'index.html'), INDEX_HTML);

  let snapshotInfo = null;
  if (args.snapshot) {
    const { json, policy } = slimForSnapshot(list);
    await mkdir(dirname(args.snapshot), { recursive: true });
    await writeFile(args.snapshot, json);
    snapshotInfo = { path: args.snapshot, bytes: Buffer.byteLength(json), policy };
  }

  // Summary
  const mb = (n) => (n / (1024 * 1024)).toFixed(2) + ' MB';
  console.log('\n=== summary ===');
  console.log(`sources:            ${finalStats.sourcesOk} ok, ${finalStats.sourcesFailed} failed`);
  for (const s of sources.filter((x) => !x.ok)) console.log(`  failed: ${s.url} (${s.error})`);
  console.log(`hosts:              ${finalStats.hosts} (pruned ${hostsPrunedRedundant} redundant subdomains)`);
  console.log(`hostExceptions:     ${finalStats.hostExceptions} (dropped ${exceptionsDroppedForYtExtra} clashing with ytExtra)`);
  console.log(`patterns:           ${finalStats.patterns}`);
  console.log(`patternExceptions:  ${finalStats.patternExceptions}`);
  console.log(`ytCosmetic:         ${finalStats.ytCosmetic}`);
  console.log(
    `dropped:            domain=${stats.droppedDomainOption} negated=${stats.droppedNegatedOption} ` +
    `unsupported=${stats.droppedUnsupportedOption} unknown=${stats.droppedUnknownOption} ` +
    `regex=${stats.droppedRegex} short=${stats.droppedShortPattern} junk=${stats.droppedJunkPattern} ` +
    `cosmetic=${stats.cosmeticSkipped}`,
  );
  console.log(`version:            ${version}${unchanged ? ` (unchanged, kept from ${previous.from})` : ''}`);
  console.log(`filters.json:       ${outFile} (${mb(bytes)})`);
  if (snapshotInfo) {
    console.log(`snapshot:           ${snapshotInfo.path} (${mb(snapshotInfo.bytes)})${snapshotInfo.policy.length ? ' — ' + snapshotInfo.policy.join('; ') : ' — full copy'}`);
  }
  console.log(`took:               ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
