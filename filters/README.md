# Ad filter pipeline

`build-filters.mjs` turns Brave's default ad-block lists into one compact JSON
file that the app's `src/lib/adblock/engine.ts` uses to decide which requests
to block. GitHub Actions rebuilds it every 6 hours and publishes it on GitHub
Pages; a snapshot is bundled with the app so it works offline on first launch.

## What the build does

1. Fetches Brave's list catalog (`brave/adblock-resources` →
   `filter_lists/list_catalog.json`) and takes every list with
   `default_enabled: true`: uBlock Origin filters, EasyList, EasyPrivacy, uBlock
   privacy/unbreak/quick-fixes, Brave's own lists, the cookie-notice and
   mobile-app-promo blockers. If the catalog is unreachable it falls back to a
   hard-coded list of the same sources. uBlock `quick-fixes.txt` is always added.
2. Downloads each source (30 s timeout; failures are recorded in `sources[]`,
   not fatal).
3. Parses Adblock Plus / uBlock syntax:
   - `||host^` → `hosts` (or `hostExceptions` for `@@` rules). Subdomains of an
     already-blocked domain are pruned; the engine matches parent domains.
   - any other network rule → `patterns` / `patternExceptions` (ABP wildcard
     syntax, options stripped).
   - rules with options we cannot honour in a mobile WebView (`domain=`,
     `redirect`, `removeparam`, `csp`, negated types, regex rules, ...) are
     dropped and counted in `stats`.
   - cosmetic rules are dropped, except those targeting `youtube.com` /
     `www.youtube.com` / `m.youtube.com`, kept verbatim in `ytCosmetic`.
4. Adds a built-in `ytExtra` set of known YouTube ad/telemetry hosts and paths
   (also hard-coded in the engine for use before any list is loaded) and a
   `neverBlockHosts` allow-list of hosts the app itself needs (host rules are
   skipped for them, path patterns still apply).
5. Writes `dist/filters.json`, `dist/version.json` and `dist/index.html`.
   The version is `YYYYMMDDTHHMMSSZ-<sha256 prefix of the rule content>`; if the
   content hash matches the previous build (local `dist/filters.json`, or the
   published file via `--previous-url`), the previous version string is kept so
   the app does not re-download an identical list.

## Enabling GitHub Pages

Once, in the repository settings:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Run the workflow manually once (**Actions → Build and publish ad filters →
   Run workflow**) or push a change under `filters/`.

Public URLs after the first deploy:

- https://alecat88.github.io/youtubemax-filters/filters.json — full list
- https://alecat88.github.io/youtubemax-filters/version.json — tiny manifest
  `{ version, generatedAt, bytes, hosts, patterns }`

## How the app uses it

- On start, the app loads the bundled snapshot `assets/filters/filters.json`
  (same shape, same `version` field) into a `FilterEngine`. Until that is done
  `isLikelyAdUrl()` covers the critical YouTube endpoints with the built-ins.
- In the background it fetches `version.json` (about 150 bytes). If `version`
  differs from the engine's current `version`, it downloads `filters.json`,
  stores it locally and swaps in a new `FilterEngine`. Nothing is downloaded
  when the version is unchanged.
- `alecat88.github.io` is in `neverBlockHosts`, so the engine cannot
  block its own updates.

## Running locally

```sh
node filters/build-filters.mjs                                   # → filters/dist/
node filters/build-filters.mjs --snapshot assets/filters/filters.json
node filters/build-filters.mjs --out /tmp/filters --previous-url https://alecat88.github.io/youtubemax-filters/filters.json
node filters/test-engine.mjs                                     # asserts against filters/dist/filters.json
node filters/test-engine.mjs assets/filters/filters.json         # ...or against the snapshot
```

Requirements: Node 22+ (the test imports the `.ts` engine directly through
Node's built-in type stripping; Node 22.6–22.x needs `--experimental-strip-types`,
Node 23.6+ has it on by default). No npm packages are needed.

`filters/dist/` and `filters/.tmp/` are git-ignored; the snapshot under
`assets/filters/` is committed and should be refreshed now and then with the
`--snapshot` command above. The snapshot is kept under 6 MB automatically (see
the policy comment at the top of `build-filters.mjs`).
