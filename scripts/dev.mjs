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
  // 브라우저는 Vite 가 열은 origin 으로 사용량 API 를 부릅니다. 그 주소를
  // 지금 등록해야 CORS 를 통과합니다 — 포트를 바꿔도 여기 값이 따라옵니다.
  const devOrigins = service.apiServer.allowOrigins([
    ...(vite.resolvedUrls?.local ?? []),
    ...(vite.resolvedUrls?.network ?? []),
  ]);
  if (!devOrigins.length) console.warn('개발 서버 주소를 확인하지 못해 CORS 허용 목록이 비었습니다. 화면이 데이터를 못 읽으면 이 줄을 먼저 보세요.');
  vite.printUrls();
  console.log(`냥토큰 트래커 사용량 API: ${service.baseUrl}`);
  reportWarmupProgress(service);
} catch (error) {
  await stop();
  console.error('냥토큰 트래커 개발 모드 시작 실패:', error);
  process.exitCode = 1;
}
