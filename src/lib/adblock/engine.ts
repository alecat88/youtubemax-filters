/**
 * Ad-filter engine for YouTubeMax.
 *
 * Pure TypeScript: no React Native, no Node imports. It consumes the JSON
 * produced by `filters/build-filters.mjs` (published at
 * https://alecat88.github.io/youtubemax-filters/filters.json and bundled as
 * assets/filters/filters.json) and answers "should this URL be blocked?".
 *
 * Matching semantics
 *   - hosts / hostExceptions: exact hostname or any parent domain
 *     (`a.b.c` matches entries `a.b.c`, `b.c` and `c`), via Set lookups on each
 *     suffix.
 *   - neverBlockHosts: hostnames the app itself needs. Host rules are ignored
 *     for them (and their subdomains); pattern rules still apply.
 *   - patterns / patternExceptions: Adblock Plus syntax compiled to RegExp
 *     once at construction — `*` wildcard, `^` separator, `||` domain anchor,
 *     `|` start/end anchors, otherwise substring match (case-insensitive).
 *   - exceptions win over blocks.
 *
 * `isLikelyAdUrl(url)` uses only the built-in YT_EXTRA rules so the app can
 * block the most important YouTube ad/telemetry endpoints before any list has
 * been loaded.
 */

export interface FilterList {
  schema: number;
  version: string;
  generatedAt: string;
  neverBlockHosts: string[];
  hosts: string[];
  hostExceptions: string[];
  patterns: string[];
  patternExceptions: string[];
  ytCosmetic?: string[];
  stats?: Record<string, number>;
}

export interface MatchResult {
  blocked: boolean;
  /** 'host' | 'pattern' | 'hostException' | 'patternException' | 'neverBlock' */
  reason?: string;
  /** the list entry that decided the result */
  rule?: string;
}

// ---------------------------------------------------------------------------
// Built-in YouTube rules (kept in sync with YT_EXTRA / NEVER_BLOCK_HOSTS in
// filters/build-filters.mjs)
// ---------------------------------------------------------------------------

export const YT_EXTRA_HOSTS: readonly string[] = [
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
];

export const YT_EXTRA_PATTERNS: readonly string[] = [
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
];

export const NEVER_BLOCK_HOSTS: readonly string[] = [
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
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Extract a lower-cased hostname from a URL without relying on the global
 * `URL` (Hermes ships an incomplete one). Handles `scheme://`, `//host`,
 * userinfo, ports, IPv6 brackets and bare `host/path` strings.
 */
export function extractHostname(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return '';
  let s = url.trim();

  let start = 0;
  const schemeEnd = s.indexOf('://');
  if (schemeEnd !== -1 && schemeEnd < 16 && /^[a-z][a-z0-9+.-]*$/i.test(s.slice(0, schemeEnd))) {
    start = schemeEnd + 3;
  } else if (s.startsWith('//')) {
    start = 2;
  } else if (/^(data|blob|about|javascript):/i.test(s)) {
    return '';
  }

  // authority ends at the first '/', '?' or '#'
  let end = s.length;
  for (let i = start; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 47 /* / */ || c === 63 /* ? */ || c === 35 /* # */) { end = i; break; }
  }
  let authority = s.slice(start, end);
  if (authority.length === 0) return '';

  const at = authority.lastIndexOf('@');
  if (at !== -1) authority = authority.slice(at + 1);

  let host: string;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    host = close === -1 ? authority.slice(1) : authority.slice(1, close);
  } else {
    const colon = authority.indexOf(':');
    host = colon === -1 ? authority : authority.slice(0, colon);
  }
  host = host.toLowerCase();
  while (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0) return '';
  if (/[\s\/\\]/.test(host)) return '';
  return host;
}

function hostnameOf(url: string): string {
  // Prefer the platform URL parser when it exists and behaves; fall back to ours.
  const U = (globalThis as { URL?: unknown }).URL as (new (u: string) => { hostname: string }) | undefined;
  if (typeof U === 'function') {
    try {
      const h = new U(url).hostname;
      if (typeof h === 'string' && h.length > 0) {
        let host = h.toLowerCase();
        if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
        while (host.endsWith('.')) host = host.slice(0, -1);
        return host;
      }
    } catch {
      /* fall through */
    }
  }
  return extractHostname(url);
}

/** Returns the matching entry (hostname or a parent domain) from `set`, or undefined. */
function findHostOrParent(host: string, set: Set<string>): string | undefined {
  if (set.size === 0 || host.length === 0) return undefined;
  if (set.has(host)) return host;
  let idx = host.indexOf('.');
  while (idx !== -1) {
    const parent = host.slice(idx + 1);
    if (set.has(parent)) return parent;
    idx = host.indexOf('.', idx + 1);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// ABP pattern compilation
// ---------------------------------------------------------------------------

const SEPARATOR_CLASS = '(?:[^a-z0-9_\\-.%]|$)';
const DOMAIN_ANCHOR = '^[a-z][a-z0-9+.\\-]*:\\/\\/(?:[^\\/?#]*\\.)?';

interface CompiledPattern {
  rule: string;
  re: RegExp;
  /** longest literal fragment of the rule, for a cheap `includes` pre-check */
  token: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?${}()[\]\\]/g, '\\$&');
}

/** Longest run of literal characters (no `*`, `^`, `|`) in a pattern, lower-cased. */
function literalToken(pattern: string): string {
  let best = '';
  for (const part of pattern.split(/[*^|]+/)) {
    if (part.length > best.length) best = part;
  }
  return best.toLowerCase();
}

function compilePattern(rule: string): CompiledPattern | null {
  let p = rule.trim().toLowerCase();
  if (p.length === 0) return null;
  let src = '';

  if (p.startsWith('||')) {
    src += DOMAIN_ANCHOR;
    p = p.slice(2);
  } else if (p.startsWith('|')) {
    src += '^';
    p = p.slice(1);
  }

  let endAnchor = false;
  if (p.endsWith('|')) {
    endAnchor = true;
    p = p.slice(0, -1);
  }

  // Build the body: escape literal runs, map * and ^
  let body = '';
  let lit = '';
  const flush = () => { if (lit) { body += escapeRegex(lit); lit = ''; } };
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      flush();
      // collapse consecutive wildcards
      if (!body.endsWith('.*')) body += '.*';
    } else if (c === '^') {
      flush();
      body += SEPARATOR_CLASS;
    } else {
      lit += c;
    }
  }
  flush();
  src += body;
  if (endAnchor) src += '$';

  try {
    return { rule, re: new RegExp(src), token: literalToken(rule) };
  } catch {
    return null;
  }
}

function matchPatterns(url: string, compiled: CompiledPattern[]): CompiledPattern | undefined {
  for (let i = 0; i < compiled.length; i++) {
    const c = compiled[i];
    if (c.token.length >= 3 && url.indexOf(c.token) === -1) continue;
    if (c.re.test(url)) return c;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class FilterEngine {
  readonly version: string;
  readonly size: { hosts: number; patterns: number };

  private readonly hosts: Set<string>;
  private readonly hostExceptions: Set<string>;
  private readonly neverBlock: Set<string>;
  private readonly patterns: CompiledPattern[];
  private readonly patternExceptions: CompiledPattern[];

  constructor(list: FilterList) {
    this.version = typeof list?.version === 'string' ? list.version : '';
    this.hosts = new Set(normaliseHosts(list?.hosts));
    this.hostExceptions = new Set(normaliseHosts(list?.hostExceptions));
    this.neverBlock = new Set(normaliseHosts(list?.neverBlockHosts));
    this.patterns = compileAll(list?.patterns);
    this.patternExceptions = compileAll(list?.patternExceptions);
    this.size = { hosts: this.hosts.size, patterns: this.patterns.length };
  }

  /** An engine with no rules at all (never blocks). */
  static empty(): FilterEngine {
    return new FilterEngine({
      schema: 1,
      version: '',
      generatedAt: '',
      neverBlockHosts: [],
      hosts: [],
      hostExceptions: [],
      patterns: [],
      patternExceptions: [],
    });
  }

  /** true if the URL should be blocked */
  shouldBlock(url: string): boolean {
    return this.match(url).blocked;
  }

  /** detail for logging: which rule matched */
  match(url: string): MatchResult {
    if (typeof url !== 'string' || url.length === 0) return { blocked: false };
    const lower = url.toLowerCase();
    const host = hostnameOf(lower);

    // 1. find a blocking rule
    let blockedBy: MatchResult | undefined;
    if (host) {
      const protectedBy = findHostOrParent(host, this.neverBlock);
      if (!protectedBy) {
        const h = findHostOrParent(host, this.hosts);
        if (h) blockedBy = { blocked: true, reason: 'host', rule: h };
      }
    }
    if (!blockedBy) {
      const p = matchPatterns(lower, this.patterns);
      if (p) blockedBy = { blocked: true, reason: 'pattern', rule: p.rule };
    }
    if (!blockedBy) return { blocked: false };

    // 2. exceptions win
    if (host) {
      const ex = findHostOrParent(host, this.hostExceptions);
      if (ex) return { blocked: false, reason: 'hostException', rule: ex };
    }
    const pex = matchPatterns(lower, this.patternExceptions);
    if (pex) return { blocked: false, reason: 'patternException', rule: pex.rule };

    return blockedBy;
  }
}

function normaliseHosts(hosts: unknown): string[] {
  if (!Array.isArray(hosts)) return [];
  const out: string[] = [];
  for (const h of hosts) {
    if (typeof h !== 'string') continue;
    const v = h.trim().toLowerCase();
    if (v) out.push(v);
  }
  return out;
}

function compileAll(patterns: unknown): CompiledPattern[] {
  if (!Array.isArray(patterns)) return [];
  const out: CompiledPattern[] = [];
  for (const p of patterns) {
    if (typeof p !== 'string') continue;
    const c = compilePattern(p);
    if (c) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Built-in fallback
// ---------------------------------------------------------------------------

let builtin: FilterEngine | undefined;

/** Engine built only from the hard-coded YouTube rules above. */
export function builtinEngine(): FilterEngine {
  if (!builtin) {
    builtin = new FilterEngine({
      schema: 1,
      version: 'builtin',
      generatedAt: '',
      neverBlockHosts: [...NEVER_BLOCK_HOSTS],
      hosts: [...YT_EXTRA_HOSTS],
      hostExceptions: [],
      patterns: [...YT_EXTRA_PATTERNS],
      patternExceptions: [],
    });
  }
  return builtin;
}

/**
 * Quick check using only the built-in YouTube ad/tracking rules, so the app
 * works before any list has been downloaded.
 */
export function isLikelyAdUrl(url: string): boolean {
  return builtinEngine().shouldBlock(url);
}
