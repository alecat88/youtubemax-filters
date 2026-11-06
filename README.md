# youtubemax-filters

Compiles Brave's default ad-block filter lists (plus uBlock quick fixes) into a compact JSON
consumed by the YouTubeMax app's request filter, and publishes it to GitHub Pages every 6 hours.

- `https://alecat88.github.io/youtubemax-filters/filters.json` — the compiled list
- `https://alecat88.github.io/youtubemax-filters/version.json` — version, size and counts (polled by the app)

`filters/build-filters.mjs` does the build (Node 22, no dependencies); `filters/test-engine.mjs`
runs the app's `src/lib/adblock/engine.ts` against the result before publishing. The engine file is a
copy of the one in the app; keep them in sync. See `filters/README.md` for the compilation rules.
