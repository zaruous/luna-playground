import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The feed is baked into the bundle at build time (src/data/news.json); the page
// never calls an API at runtime. Warn early when that file is still empty, so an
// empty page is not mistaken for a network or CORS failure.
function feedStatusPlugin() {
  return {
    name: 'newstrend-feed-status',
    buildStart() {
      try {
        const data = JSON.parse(readFileSync(new URL('./src/data/news.json', import.meta.url), 'utf8'));
        if (!data.items?.length) {
          this.warn('src/data/news.json has no stories. Run `npm run news:refresh` before `npm run dev` or `npm run build`.');
        }
      } catch (error) {
        this.warn(`src/data/news.json could not be read: ${error.message}`);
      }
    },
  };
}

// Production assets are referenced relatively so the built site works from any
// host, port, or sub-path (GitHub Pages /luna-playground/, `vite preview`, a
// plain static server at the root). The dev server stays on '/' so
// http://localhost:<port>/ serves the app whichever port Vite picks.
export default defineConfig(({ command }) => ({
  plugins: [react(), feedStatusPlugin()],
  base: process.env.VITE_BASE ?? (command === 'build' ? './' : '/'),
}));
