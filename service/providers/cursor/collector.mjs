import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { UsageProviderAdapter, createReconcileGuard } from '../contracts.mjs';
import { accountingOf } from '../accounting.mjs';
import {
  cliChatId,
  cursorIdeGlobalStorageDb,
  discoverCliChatDbs,
  readCliChatMeta,
  resolveCursorAppData,
  resolveCursorHome,
} from './detector.mjs';
import { CURSOR_PARSER_VERSION, parseCliChat, parseIdeComposerHeader } from './parser.mjs';

// Cursor 는 다른 provider 와 데이터 모양이 다릅니다 — 요청 단위 입력/출력
// 델타가 아니라 "그 시점 컨텍스트 창 구성 스냅샷"입니다
// (docs/dev/cursor/decisions.md 결정 1). 그래서 이 어댑터는 usage_events 를
// 절대 건드리지 않고 cursor_local_activity 에만 씁니다(결정 4) — upsertSession/
// upsertUsageEvent/insertUsageEvent 호출이 이 파일에 하나도 없는 것이 그
// 경계를 지키고 있다는 뜻입니다.
export class CursorCollector extends UsageProviderAdapter {
  constructor({
    store,
    cursorHome = resolveCursorHome(),
    cursorAppData = resolveCursorAppData(),
    reconcileIntervalMs = 5000,
  } = {}) {
    super({
      id: 'cursor',
      name: 'Cursor',
      measurement: 'local_observed',
      capabilities: {
        localLedger: true,
        // 불리언으로는 "요청 델타가 있다/없다" 밖에 못 말합니다. Cursor 는
        // 토큰은 있지만 그 모양이 다르므로 문자열입니다 — 화면은 이 값이
        // 'context_snapshot' 이면 usage-timeseries·캐시 적중률처럼 "요청 델타"를
        // 전제하는 계산에서 조기 배제해야 합니다(docs/dev/cursor/decisions.md 결정 5).
        tokenLedger: 'context_snapshot',
        serverQuota: false,
        // 대화 구조(role 나열)는 있지만 턴 경계·도구 이름 매핑은 미확인입니다.
        turnLedger: false,
        // cursor-agent CLI 의 hook 규약을 확인하지 못했습니다. true 로 두면
        // 화면에 누를 수 없는 설치 버튼이 생깁니다.
        hooks: false,
        telemetry: false,
        credentials: 'none',
        accounting: 'context_only',
        tokenAccounting: accountingOf('cursor'),
      },
    });
    this.store = store;
    this.cursorHome = cursorHome;
    this.cursorAppData = cursorAppData;
    this.ideDbPath = cursorIdeGlobalStorageDb(cursorAppData);
    this.reconcileIntervalMs = reconcileIntervalMs;
    this.watchers = new Map();
    this.scanInFlight = new Map();
    this.reconcileTimer = null;
    this.guardedReconcile = createReconcileGuard();
    this.status = {
      provider: 'cursor',
      detected: false,
      ledgerAvailable: false,
      watching: false,
      lastScanAt: null,
      lastError: null,
      filesDiscovered: 0,
      parserVersion: CURSOR_PARSER_VERSION,
      unchangedByHash: 0,
      parseErrors: 0,
      // Gemini 의 sources.legacyChats/sources.antigravity 와 같은 모양입니다 —
      // src/shared.js 의 cursorSourceState() 가 같은 패턴을 재사용합니다.
      sources: {
        cli: { present: false, chats: 0 },
        ide: { present: false, composers: 0 },
      },
    };
  }

  async #refreshSources() {
    const chatDbPaths = await discoverCliChatDbs(this.cursorHome);
    const idePresent = Boolean(this.ideDbPath) && fs.existsSync(this.ideDbPath);
    this.status.sources = {
      cli: { present: chatDbPaths.length > 0, chats: chatDbPaths.length },
      ide: { present: idePresent, composers: this.status.sources?.ide?.composers ?? 0 },
    };
    this.status.detected = chatDbPaths.length > 0 || idePresent;
    this.status.ledgerAvailable = this.status.detected;
    return { chatDbPaths, idePresent };
  }

  async detect() {
    const { chatDbPaths, idePresent } = await this.#refreshSources();
    return chatDbPaths.length > 0 || idePresent;
  }

  async discoverFiles() {
    const { chatDbPaths, idePresent } = await this.#refreshSources();
    const files = [...chatDbPaths];
    if (idePresent) files.push(this.ideDbPath);
    this.status.filesDiscovered = files.length;
    return files;
  }

  scanFile(filePath, reason = 'reconcile') {
    if (this.scanInFlight.has(filePath)) return this.scanInFlight.get(filePath);
    const isIde = filePath === this.ideDbPath;
    const task = (isIde ? this.#scanIdeGlobalStorage(reason) : this.#scanCliChat(filePath, reason))
      .finally(() => this.scanInFlight.delete(filePath));
    this.scanInFlight.set(filePath, task);
    return task;
  }

  // CLI 대화 한 건(store.db) — 파일 mtime+size 로 1차 거르고, 바뀌었으면 내용
  // 해시까지 비교합니다(WAL 체크포인트가 mtime 만 건드리고 내용은 그대로인
  // 경우가 있어서입니다 — Gemini 의 .json 스냅샷 전략과 같은 이유·같은 방법,
  // docs/dev/cursor/decisions.md 결정 3).
  async #scanCliChat(dbPath, reason) {
    let stat;
    try {
      stat = await fsp.stat(dbPath);
    } catch {
      return { changed: false, reason: 'missing' };
    }

    const scanState = this.store.getScanState(this.id, dbPath);
    const parserCurrent = (scanState?.parserVersion ?? 0) >= CURSOR_PARSER_VERSION;
    if (scanState && parserCurrent && scanState.mtimeMs === stat.mtimeMs && scanState.fileSize === stat.size) {
      return { changed: false, reason: 'unchanged' };
    }

    let buffer;
    try {
      buffer = await fsp.readFile(dbPath);
    } catch {
      return { changed: false, reason: 'missing' };
    }
    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (scanState && parserCurrent && scanState.contentHash === contentHash) {
      this.status.unchangedByHash += 1;
      this.store.saveScanState({
        provider: this.id, sourcePath: dbPath, byteOffset: 0, fileSize: stat.size, mtimeMs: stat.mtimeMs,
        previousUsage: {}, sessionId: cliChatId(dbPath), parserVersion: CURSOR_PARSER_VERSION, contentHash,
      });
      return { changed: false, reason: 'hash-unchanged' };
    }

    const chatId = cliChatId(dbPath);
    const meta = await readCliChatMeta(dbPath);
    let event;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      // rowid 오름차순이라야 "가장 나중 breakdown" 이 곧 "최신 관측값"입니다
      // (parser.mjs parseCliChat 주석 참고).
      const rows = db.prepare('SELECT rowid, id, data FROM blobs ORDER BY rowid ASC').all();
      event = parseCliChat({
        chatId, cwd: meta?.cwd ?? null, createdAtMs: meta?.createdAtMs ?? null,
        updatedAtMs: meta?.updatedAtMs ?? null, blobRows: rows,
      });
    } catch (error) {
      this.status.parseErrors += 1;
      this.status.lastError = String(error?.message ?? error);
      return { changed: false, reason: 'parse-error' };
    } finally {
      db?.close();
    }

    const observedAt = new Date().toISOString();
    const changed = this.store.upsertCursorActivity(event, observedAt);
    this.store.saveScanState({
      provider: this.id, sourcePath: dbPath, byteOffset: 0, fileSize: stat.size, mtimeMs: stat.mtimeMs,
      previousUsage: {}, sessionId: chatId, parserVersion: CURSOR_PARSER_VERSION, contentHash,
    });
    this.status.lastScanAt = observedAt;
    this.status.lastError = null;
    if (changed) this.emit('updated', { provider: 'cursor', filePath: dbPath, reason, surface: 'cli' });
    return { changed, reason };
  }

  // IDE 쪽은 composerHeaders 만 읽습니다 — cursorDiskKV(대화 청크 blob)와
  // ItemTable(cursorAuth/*, secret://* 포함)은 이 어댑터가 열지 않습니다. 절대
  // 토큰 breakdown 을 컴포저에 귀속시킬 근거가 없다는 스코프 결정(위 상단 주석,
  // docs/dev/cursor/decisions.md Phase 0b)의 직접적인 결과입니다 — 열 이유
  // 자체가 없으므로 코드에도 그 테이블을 여는 경로가 없습니다.
  async #scanIdeGlobalStorage(reason) {
    if (!this.ideDbPath) return { changed: false, reason: 'no-ide' };
    let stat;
    try {
      stat = await fsp.stat(this.ideDbPath);
    } catch {
      return { changed: false, reason: 'missing' };
    }

    const scanState = this.store.getScanState(this.id, this.ideDbPath);
    const parserCurrent = (scanState?.parserVersion ?? 0) >= CURSOR_PARSER_VERSION;
    // state.vscdb 는 Cursor IDE 의 다른 기능(설정 등)도 같이 쓰는 파일이라
    // mtime 이 컴포저와 무관하게 자주 바뀝니다. 전체 파일을 해시하면(수십만
    // cursorDiskKV 행까지 포함) 매번 큰 비용이 들고, 우리가 읽는 건 그중
    // composerHeaders(수백 행) 뿐이므로 mtime+size 만으로 거릅니다 — false
    // positive(안 바뀌었는데 다시 읽음)의 비용은 이 규모에서 무시할 만합니다.
    if (scanState && parserCurrent && scanState.mtimeMs === stat.mtimeMs && scanState.fileSize === stat.size) {
      return { changed: false, reason: 'unchanged' };
    }

    let rows = [];
    let db;
    try {
      db = new DatabaseSync(this.ideDbPath, { readOnly: true });
      rows = db.prepare('SELECT composerId, workspaceId, createdAt, lastUpdatedAt, value FROM composerHeaders').all();
    } catch (error) {
      // 테이블이 없는 버전이거나, IDE 가 그 순간 파일을 쓰고 있어 잠겼을 수
      // 있습니다. 다음 reconcile 이 재시도합니다 — 에러로 죽이지 않습니다.
      this.status.lastError = String(error?.message ?? error);
      return { changed: false, reason: 'open-error' };
    } finally {
      db?.close();
    }

    const observedAt = new Date().toISOString();
    let anyChanged = false;
    let composers = 0;
    this.store.transaction(() => {
      for (const row of rows) {
        let event;
        try {
          event = parseIdeComposerHeader({
            composerId: row.composerId, workspaceId: row.workspaceId,
            createdAt: row.createdAt, lastUpdatedAt: row.lastUpdatedAt, value: row.value,
          });
        } catch {
          this.status.parseErrors += 1;
          continue;
        }
        composers += 1;
        if (this.store.upsertCursorActivity(event, observedAt)) anyChanged = true;
      }
    });
    this.status.sources.ide.composers = composers;

    this.store.saveScanState({
      provider: this.id, sourcePath: this.ideDbPath, byteOffset: 0, fileSize: stat.size, mtimeMs: stat.mtimeMs,
      previousUsage: {}, sessionId: null, parserVersion: CURSOR_PARSER_VERSION, contentHash: null,
    });
    this.status.lastScanAt = observedAt;
    this.status.lastError = null;
    if (anyChanged) this.emit('updated', { provider: 'cursor', filePath: this.ideDbPath, reason, surface: 'ide' });
    return { changed: anyChanged, reason };
  }

  reconcile(reason = 'interval') {
    return this.guardedReconcile(async () => {
      try {
        await this.detect();
        if (!this.status.detected) return { changed: false, files: 0 };
        const files = await this.discoverFiles();
        let changed = false;
        for (const filePath of files) {
          const result = await this.scanFile(filePath, reason);
          changed ||= Boolean(result?.changed);
        }
        await this.refreshWatchers(files);
        this.status.lastScanAt = new Date().toISOString();
        this.status.lastError = null;
        return { changed, files: files.length };
      } catch (error) {
        this.status.lastError = String(error?.message ?? error);
        this.emit('error-state', { provider: 'cursor', error: this.status.lastError });
        return { changed: false, error: this.status.lastError };
      }
    });
  }

  // store.db 의 부모 디렉터리(각 CLI 대화)와 IDE globalStorage 디렉터리만
  // 감시합니다 — chats 전체를 감시하면 워크스페이스 수만큼 watcher 가 늡니다.
  async refreshWatchers(knownFiles = null) {
    const files = knownFiles ?? await this.discoverFiles();
    const dirs = new Set(files.map((filePath) => path.dirname(filePath)));

    for (const [dir, watcher] of this.watchers) {
      if (!dirs.has(dir)) {
        watcher.close();
        this.watchers.delete(dir);
      }
    }

    for (const dir of dirs) {
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, { persistent: false }, (_eventType, filename) => {
          const name = filename ? String(filename) : null;
          if (name && (name === 'store.db' || name === 'state.vscdb')) {
            const target = path.join(dir, name);
            setTimeout(() => this.scanFile(target, 'fs-watch').catch(() => {}), 80);
          } else {
            setTimeout(() => this.reconcile('fs-watch-directory').catch(() => {}), 120);
          }
        });
        watcher.on('error', () => {
          watcher.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, watcher);
      } catch {
        // 주기 reconcile 이 신뢰성 폴백입니다.
      }
    }
    this.status.watching = this.watchers.size > 0;
  }

  async start({ backfill = true } = {}) {
    await this.detect();
    if (backfill) {
      await this.reconcile('startup');
      this.startWatching();
    }
    return this.getStatus();
  }

  startWatching() {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => this.reconcile('interval'), this.reconcileIntervalMs);
    this.reconcileTimer.unref?.();
  }

  async backfill(reason = 'startup', { onProgress = null } = {}) {
    await this.detect();
    if (!this.status.detected) {
      onProgress?.({ detected: false, filesTotal: 0, filesDone: 0 });
      return { changed: false, files: 0 };
    }

    const files = await this.discoverFiles();
    let changed = false;
    let done = 0;
    let failures = 0;
    onProgress?.({ detected: true, filesTotal: files.length, filesDone: 0 });

    for (const filePath of files) {
      try {
        const result = await this.scanFile(filePath, reason);
        changed ||= Boolean(result?.changed);
      } catch (error) {
        failures += 1;
        this.status.lastError = String(error?.message ?? error);
        this.emit('error-state', { provider: 'cursor', error: this.status.lastError });
      } finally {
        done += 1;
        onProgress?.({ detected: true, filesTotal: files.length, filesDone: done });
      }
    }

    await this.refreshWatchers(files);
    this.status.lastScanAt = new Date().toISOString();
    if (!failures) this.status.lastError = null;
    return { changed, files: files.length, failures };
  }

  stop() {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.status.watching = false;
  }

  getStatus() {
    return { ...this.status, watcherCount: this.watchers.size };
  }
}
