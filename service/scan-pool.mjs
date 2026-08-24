import os from 'node:os';
import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./scan-worker.mjs', import.meta.url);
// 파싱은 병렬이지만 스토어 쓰기는 여전히 메인 스레드 하나입니다. 그래서 쓰기
// 시간이 바닥값이 되고, 생산자를 더 늘려도 그 바닥 아래로는 못 내려갑니다.
// 실측(899파일 / 1GB): 워커 1개 20.0초, 2개 17.2초, 4개 17.5초 — 2개에서
// 포화입니다. 로그 모양이 달라 파싱이 훨씬 비싼 환경이라면
// NYANG_SCAN_WORKERS 로 올릴 수 있습니다.
const MAX_WORKERS = 2;

export function defaultScanWorkerCount() {
  const configured = Number(process.env.NYANG_SCAN_WORKERS);
  if (Number.isFinite(configured) && configured >= 0) return Math.floor(configured);
  const parallelism = os.availableParallelism?.() ?? os.cpus().length ?? 1;
  return Math.max(1, Math.min(MAX_WORKERS, parallelism - 1));
}

// 파일 하나를 워커 하나가 통째로 맡습니다. 파서 상태가 파일 단위라 파일을
// 쪼개면 이어붙일 수 없기 때문입니다. 대신 결과는 배치로 흘려보내 메인
// 스레드가 파일이 끝나기를 기다리지 않고 적재합니다.
export class ScanPool {
  constructor({ size = defaultScanWorkerCount(), workerUrl = WORKER_URL } = {}) {
    this.size = Math.max(1, size);
    this.workerUrl = workerUrl;
    this.idle = [];
    this.live = new Set();
    this.waiting = [];
    this.closed = false;
  }

  get workerCount() {
    return this.live.size;
  }

  #spawn() {
    const worker = new Worker(this.workerUrl);
    // 백필이 끝나기 전에 사용자가 서버를 끄면 워커가 프로세스를 붙잡고
    // 있어서는 안 됩니다.
    worker.unref();
    worker.on('error', () => {});
    this.live.add(worker);
    return worker;
  }

  #drainWaiting() {
    while (this.waiting.length && (this.idle.length || this.live.size < this.size)) {
      const waiter = this.waiting.shift();
      waiter.resolve(this.idle.pop() ?? this.#spawn());
    }
  }

  async #acquire() {
    if (this.closed) throw new Error('스캔 풀이 이미 닫혔습니다');
    if (this.idle.length) return this.idle.pop();
    if (this.live.size < this.size) return this.#spawn();
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  #release(worker) {
    if (this.closed) {
      this.#terminate(worker);
      return;
    }
    this.idle.push(worker);
    this.#drainWaiting();
  }

  // 실패한 워커는 파일을 읽던 중일 수 있습니다. 재사용하면 남은 배치가 다음
  // 작업에 섞이므로 버립니다.
  #terminate(worker) {
    this.live.delete(worker);
    worker.terminate().catch(() => {});
  }

  #discard(worker) {
    this.#terminate(worker);
    this.#drainWaiting();
  }

  async submit(job, onBatch) {
    const worker = await this.#acquire();
    let completed = false;
    try {
      const result = await new Promise((resolve, reject) => {
        const detach = () => {
          worker.off('message', onMessage);
          worker.off('error', onWorkerError);
          worker.off('exit', onExit);
        };
        function onMessage(message) {
          if (message?.type === 'batch') {
            try {
              onBatch(message.events);
            } catch (error) {
              detach();
              reject(error);
            }
            return;
          }
          detach();
          if (message?.type === 'error') {
            const error = new Error(message.message);
            if (message.code) error.code = message.code;
            reject(error);
            return;
          }
          resolve(message?.result);
        }
        function onWorkerError(error) {
          detach();
          reject(error);
        }
        function onExit(code) {
          detach();
          reject(new Error(`스캔 워커가 예기치 않게 종료됐습니다 (code ${code})`));
        }
        worker.on('message', onMessage);
        worker.on('error', onWorkerError);
        worker.on('exit', onExit);
        worker.postMessage(job);
      });
      completed = true;
      return result;
    } finally {
      if (completed) this.#release(worker);
      else this.#discard(worker);
    }
  }

  async close() {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter.reject(new Error('스캔 풀이 닫혔습니다'));
    }
    const workers = [...this.live];
    this.live.clear();
    this.idle.length = 0;
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => {})));
  }
}

// 워커가 파일 끝에서 들고 있던 파서 상태를 메인 스레드 쪽 상태에 옮깁니다.
// 커서 저장이 이 값들을 읽기 때문에 마감 전에 반드시 합쳐야 합니다.
export function applyParserTail(parserState, tail) {
  if (!parserState || !tail) return parserState;
  if (tail.previousUsage) parserState.previousUsage = tail.previousUsage;
  if (tail.session) parserState.session = tail.session;
  if (tail.stats) parserState.stats = tail.stats;
  return parserState;
}
