import { createServer } from 'vite';
import { reportWarmupProgress, startUsageService } from './usage-service.mjs';

function clientConfigPlugin(config) {
  const serialized = JSON.stringify(config).replaceAll('<', '\\u003c');
  return {
    name: 'nyang-dev-client-config',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [{
        tag: 'script',
        injectTo: 'head',
        children: `window.__NYANG_TRACKER_CONFIG__=${serialized};`,
      }],
    },
  };
}

let service = null;
let vite = null;

async function stop() {
  await vite?.close().catch(() => {});
  await service?.stop().catch(() => {});
}

process.on('SIGINT', () => stop().finally(() => process.exit(0)));
process.on('SIGTERM', () => stop().finally(() => process.exit(0)));

try {
  service = await startUsageService();
  vite = await createServer({ plugins: [clientConfigPlugin(service.apiServer.clientConfig())] });
  await vite.listen();
  vite.printUrls();
  console.log(`냥토큰 트래커 사용량 API: ${service.baseUrl}`);
  reportWarmupProgress(service);
} catch (error) {
  await stop();
  console.error('냥토큰 트래커 개발 모드 시작 실패:', error);
  process.exitCode = 1;
}
