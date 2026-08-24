# NewsTrend

NewsTrend is a React-based daily news dashboard for the Luna playground repository.

## Features

- Up to 20 same-day stories from Google News Korea Top Stories
- Korean-time (Asia/Seoul) day filtering
- Category filters and title/source search
- Original-story navigation through the source link supplied by Google News RSS
- Markdown download for the current filtered list
- Responsive editorial-style React interface
- GitHub Actions build validation and scheduled GitHub Pages refresh every 30 minutes

## Local commands

```bash
npm install
npm test
npm run news:refresh
npm run dev
```

The news refresh script writes `src/data/news.json`. The GitHub Pages workflow refreshes the feed immediately before every production build.

## Data flow

The page has no runtime API call. `scripts/fetch-news.mjs` writes `src/data/news.json`, and `src/App.jsx` imports that file, so the story list is baked into the JavaScript bundle at build time. A browser therefore never issues a cross-origin request for news, and CORS or a changed dev-server port cannot break the data.

Local order of operations:

```bash
npm run news:refresh   # writes src/data/news.json
npm run dev            # or: npm run dev:fresh (refresh + dev in one step)
```

## Serving the built site

`npm run build` emits relative asset URLs (`./assets/...`), so `dist/` works when served from a domain root, from `/luna-playground/` on GitHub Pages, from `vite preview`, or from any other port or sub-path. Set `VITE_BASE` to force an absolute base if a host needs one.

The dev server is served at `/`, so `http://localhost:<port>/` opens the app whichever port Vite picks.

## When the page shows no stories

`WAITING FOR FEED` with `00 STORIES` means `src/data/news.json` holds no items — the checked-in file is an empty placeholder. Run `npm run news:refresh`, then restart the dev server or rebuild. Vite also prints a warning at dev/build start while the file is empty.

If the refresh script fails with `All Google News feeds failed`, the Node process could not reach `news.google.com`; check network, proxy, or firewall access. That failure happens in Node, not in the browser, so it is not a CORS problem.

A blank page with 404s for `/luna-playground/assets/*` in the console means the built site is served with the wrong base path — rebuild with the current config, which uses relative asset URLs.

## GitHub Pages

The repository must have **Settings → Pages → Build and deployment → Source → GitHub Actions** enabled once. After that, pushes to `main`, manual runs, and the scheduled workflow deploy the current site.
