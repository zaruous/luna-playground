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

## GitHub Pages

The repository must have **Settings → Pages → Build and deployment → Source → GitHub Actions** enabled once. After that, pushes to `main`, manual runs, and the scheduled workflow deploy the current site.
