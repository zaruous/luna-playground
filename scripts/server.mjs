import fs from 'node:fs';
import path from 'node:path';
import { reportWarmupProgress, rootDir, startUsageService } from './usage-service.mjs';

const staticRoot = path.join(rootDir, 'dist');
const host = process.env.NYANG_HOST || '127.0.0.1';
const port = Number(process.env.NYANG_PORT || 47831);

if (!fs.existsSync(path.join(staticRoot, 'index.html'))) {
  throw new Error('dist/index.html이 없습니다. 먼저 npm run build를 실행하세요.');
}

let service = null;

async function stop() {
  await service?.stop().catch(() => {});
}

process.on('SIGINT', () => stop().finally(() => process.exit(0)));
process.on('SIGTERM', () => stop().finally(() => process.exit(0)));

try {
  service = await startUsageService({ host, port, staticRoot });
  console.log(`냥토큰 트래커 서버: ${service.baseUrl}`);
  reportWarmupProgress(service);
} catch (error) {
  await stop();
  console.error('냥토큰 트래커 서버 시작 실패:', error);
  process.exitCode = 1;
}
