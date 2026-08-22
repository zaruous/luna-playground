import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isoNow, projectKeyOf, projectNameFromCwd, worstQuality } from './utils.mjs';
import { dominantPhase, splitTokensByPhase } from './providers/tool-phases.mjs';
import { accountingOf, promptSideTokens, reuseMultiple } from './providers/accounting.mjs';

function normalizeProviderId(value) {
  const provider = String(value ?? '').trim().toLowerCase();
  if (!provider) throw new TypeError('provider id is required');
  return provider;
}

function normalizeLimitId(value) {
  return String(value ?? 'default').trim().toLowerCase().replaceAll('-', '_') || 'default';
}

function stableEventKey(provider, sessionId, eventTimestamp, model, usage) {
  if (!eventTimestamp) return null;
  return [
    provider, sessionId, eventTimestamp, model ?? '',
    usage.inputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens,
    usage.outputTokens, usage.reasoningTokens, usage.totalTokens,
  ].join('|');
}

function stableSnapshotKey(provider, sessionId, eventTimestamp, limitId, windowType, window) {
  if (!eventTimestamp) return null;
  return [
    provider, sessionId ?? '', eventTimestamp, limitId, windowType,
    window.usedPercent, window.windowMinutes ?? '', window.resetsAt ?? '',
  ].join('|');
}

export class UsageStore {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        cwd TEXT,
        project_name TEXT,
        model TEXT,
        model_provider TEXT,
        cli_version TEXT,
        source TEXT,
        git_sha TEXT,
        git_branch TEXT,
        git_origin_url TEXT,
        started_at TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(provider, session_id)
      );

      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_offset INTEGER NOT NULL,
        event_timestamp TEXT,
        observed_at TEXT NOT NULL,
        cwd TEXT,
        project_name TEXT,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        tool_tokens INTEGER NOT NULL DEFAULT 0,
        cumulative_reset INTEGER NOT NULL DEFAULT 0,
        measurement_source TEXT NOT NULL DEFAULT 'local_log',
        measurement_quality TEXT NOT NULL DEFAULT 'observed',
        event_key TEXT,
        field_quality TEXT,
        parser_version INTEGER,
        request_id TEXT,
        turn_index INTEGER,
        tool_counts TEXT,
        touched_paths TEXT,
        UNIQUE(provider, source_path, source_offset)
      );

      CREATE TABLE IF NOT EXISTS server_usage_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        session_id TEXT,
        source_path TEXT NOT NULL,
        source_offset INTEGER NOT NULL,
        event_timestamp TEXT,
        observed_at TEXT NOT NULL,
        limit_id TEXT,
        limit_name TEXT,
        window_type TEXT NOT NULL,
        used_percent REAL NOT NULL,
        window_minutes INTEGER,
        resets_at INTEGER,
        measurement_source TEXT NOT NULL DEFAULT 'server_snapshot',
        snapshot_key TEXT,
        UNIQUE(provider, source_path, source_offset, window_type)
      );

      CREATE TABLE IF NOT EXISTS reconciliation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        limit_id TEXT NOT NULL DEFAULT 'default',
        window_type TEXT NOT NULL,
        window_minutes INTEGER NOT NULL DEFAULT -1,
        from_observed_at TEXT NOT NULL,
        to_observed_at TEXT NOT NULL,
        server_usage_delta REAL,
        local_token_delta INTEGER NOT NULL DEFAULT 0,
        classification TEXT NOT NULL,
        confidence TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(provider, limit_id, window_type, window_minutes, from_observed_at, to_observed_at)
      );

      CREATE TABLE IF NOT EXISTS scan_state (
        source_path TEXT PRIMARY KEY,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        file_size INTEGER NOT NULL DEFAULT 0,
        mtime_ms REAL,
        last_input_tokens INTEGER NOT NULL DEFAULT 0,
        last_cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        last_cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
        last_output_tokens INTEGER NOT NULL DEFAULT 0,
        last_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        last_total_tokens INTEGER NOT NULL DEFAULT 0,
        last_session_id TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_scan_state (
        provider TEXT NOT NULL,
        source_path TEXT NOT NULL,
        parser_version INTEGER,
        content_hash TEXT,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        file_size INTEGER NOT NULL DEFAULT 0,
        mtime_ms REAL,
        last_input_tokens INTEGER NOT NULL DEFAULT 0,
        last_cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        last_cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
        last_output_tokens INTEGER NOT NULL DEFAULT 0,
        last_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        last_total_tokens INTEGER NOT NULL DEFAULT 0,
        last_session_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(provider, source_path)
      );

      -- 턴 경계 원장. "사람 프롬프트 1개 ~ 다음 프롬프트까지"가 한 턴입니다.
      -- 여기에는 **경계 사실만** 담습니다 — 토큰 합계는 두지 않습니다.
      -- 토큰을 여기에 누적하면 증분 tail 이 턴 중간을 가를 때와 resume 사본에서
      -- 이중 계상이 생깁니다. 대신 usage_events.turn_index 로 요청을 턴에 매달고
      -- 집계는 SQL 로 뽑아, 원장의 멱등성을 그대로 물려받습니다.
      -- 프롬프트 본문은 담지 않습니다(docs/dev/menus/session.md).
      CREATE TABLE IF NOT EXISTS turns (
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        started_at TEXT,
        compacted INTEGER NOT NULL DEFAULT 0,
        parser_version INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, session_id, turn_index)
      );

      CREATE TABLE IF NOT EXISTS project_aliases (
        provider TEXT NOT NULL,
        project_key TEXT NOT NULL,
        alias TEXT NOT NULL,
        redacted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, project_key)
      );

      CREATE INDEX IF NOT EXISTS idx_usage_events_provider_time ON usage_events(provider, observed_at);
      CREATE INDEX IF NOT EXISTS idx_usage_events_project ON usage_events(provider, project_name, observed_at);
      CREATE INDEX IF NOT EXISTS idx_server_snapshots_provider_time ON server_usage_snapshots(provider, observed_at);
      CREATE INDEX IF NOT EXISTS idx_reconcile_provider_time ON reconciliation_events(provider, to_observed_at);
      CREATE INDEX IF NOT EXISTS idx_turns_provider_time ON turns(provider, started_at);
      CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(provider, session_id, event_timestamp);
    `);

    this.#upgradeSchema();
  }

  #tableColumns(table) {
    return new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  }

  #upgradeSchema() {
    const usageColumns = this.#tableColumns('usage_events');
    if (!usageColumns.has('event_key')) this.db.exec('ALTER TABLE usage_events ADD COLUMN event_key TEXT');
    // docs/dev/store-extensions.md §1 — provider 별로 필요해진 것만 추가합니다.
    // tool_tokens 는 Gemini(M5) 용 예약 필드이고, 나머지 셋은 Claude 가 지금 씁니다.
    if (!usageColumns.has('tool_tokens')) this.db.exec('ALTER TABLE usage_events ADD COLUMN tool_tokens INTEGER NOT NULL DEFAULT 0');
    if (!usageColumns.has('field_quality')) this.db.exec('ALTER TABLE usage_events ADD COLUMN field_quality TEXT');
    if (!usageColumns.has('parser_version')) this.db.exec('ALTER TABLE usage_events ADD COLUMN parser_version INTEGER');
    if (!usageColumns.has('request_id')) this.db.exec('ALTER TABLE usage_events ADD COLUMN request_id TEXT');
    // docs/dev/menus/session.md — 절차별 토큰 배분을 보기 위해 요청 행에
    // 달리는 구조 메타입니다. 집계를 별도 테이붔에 넣지 않으니 원장이
    // 유지하는 중복 제거가 그대로 적용됩니다.
    if (!usageColumns.has('turn_index')) this.db.exec('ALTER TABLE usage_events ADD COLUMN turn_index INTEGER');
    if (!usageColumns.has('tool_counts')) this.db.exec('ALTER TABLE usage_events ADD COLUMN tool_counts TEXT');
    if (!usageColumns.has('touched_paths')) this.db.exec('ALTER TABLE usage_events ADD COLUMN touched_paths TEXT');

    // docs/dev/store-extensions.md §2 — 파서가 버전업 되면 이전 버전으로
    // 읽은 파일을 한 번 다시 해석해야 합니다. 그 판정 기준입니다.
    const scanColumns = this.#tableColumns('provider_scan_state');
    if (!scanColumns.has('parser_version')) this.db.exec('ALTER TABLE provider_scan_state ADD COLUMN parser_version INTEGER');
    if (!scanColumns.has('content_hash')) this.db.exec('ALTER TABLE provider_scan_state ADD COLUMN content_hash TEXT');

    const snapshotColumns = this.#tableColumns('server_usage_snapshots');
    if (!snapshotColumns.has('snapshot_key')) this.db.exec('ALTER TABLE server_usage_snapshots ADD COLUMN snapshot_key TEXT');

    const reconciliationColumns = this.#tableColumns('reconciliation_events');
    if (!reconciliationColumns.has('limit_id')) {
      this.db.exec(`
        BEGIN;
        ALTER TABLE reconciliation_events RENAME TO reconciliation_events_legacy;
        CREATE TABLE reconciliation_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL,
          limit_id TEXT NOT NULL DEFAULT 'default',
          window_type TEXT NOT NULL,
          window_minutes INTEGER NOT NULL DEFAULT -1,
          from_observed_at TEXT NOT NULL,
          to_observed_at TEXT NOT NULL,
          server_usage_delta REAL,
          local_token_delta INTEGER NOT NULL DEFAULT 0,
          classification TEXT NOT NULL,
          confidence TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(provider, limit_id, window_type, window_minutes, from_observed_at, to_observed_at)
        );
        INSERT INTO reconciliation_events (
          id, provider, limit_id, window_type, window_minutes, from_observed_at, to_observed_at,
          server_usage_delta, local_token_delta, classification, confidence, created_at
        )
        SELECT id, provider, 'default', window_type, -1, from_observed_at, to_observed_at,
               server_usage_delta, local_token_delta, classification, confidence, created_at
        FROM reconciliation_events_legacy;
        DROP TABLE reconciliation_events_legacy;
        COMMIT;
      `);
    }

    const upgradedReconciliationColumns = this.#tableColumns('reconciliation_events');
    if (!upgradedReconciliationColumns.has('window_minutes')) {
      this.db.exec(`
        BEGIN;
        ALTER TABLE reconciliation_events RENAME TO reconciliation_events_without_minutes;
        CREATE TABLE reconciliation_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL,
          limit_id TEXT NOT NULL DEFAULT 'default',
          window_type TEXT NOT NULL,
          window_minutes INTEGER NOT NULL DEFAULT -1,
          from_observed_at TEXT NOT NULL,
          to_observed_at TEXT NOT NULL,
          server_usage_delta REAL,
          local_token_delta INTEGER NOT NULL DEFAULT 0,
          classification TEXT NOT NULL,
          confidence TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(provider, limit_id, window_type, window_minutes, from_observed_at, to_observed_at)
        );
        INSERT INTO reconciliation_events (
          id, provider, limit_id, window_type, window_minutes, from_observed_at, to_observed_at,
          server_usage_delta, local_token_delta, classification, confidence, created_at
        )
        SELECT id, provider, limit_id, window_type, -1, from_observed_at, to_observed_at,
               server_usage_delta, local_token_delta, classification, confidence, created_at
        FROM reconciliation_events_without_minutes;
        DROP TABLE reconciliation_events_without_minutes;
        COMMIT;
      `);
    }

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_events_event_key
        ON usage_events(provider, event_key) WHERE event_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_server_snapshots_key
        ON server_usage_snapshots(provider, snapshot_key) WHERE snapshot_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_server_snapshots_limit_time
        ON server_usage_snapshots(provider, limit_id, window_type, observed_at);
      CREATE INDEX IF NOT EXISTS idx_reconcile_provider_time
        ON reconciliation_events(provider, to_observed_at);

      -- 아래 넷은 **표현식을 그대로** 색인합니다. 조회하는 쪽도 같은 COALESCE
      -- 를 쓰기 때문에 SQLite 가 이 색인을 탑니다. 컬럼만 색인해 두면 provider
      -- 로만 좁혀지고 COALESCE 는 전수 평가가 되어, 스냅샷 한 건 넣을 때마다
      -- 원장 전체를 훑습니다 — 첫 백필이 O(n²) 로 커지는 지점이 정확히
      -- 여기였습니다(스냅샷 3.4만 건에 35분).
      -- turn_index 를 쓰는 색인이 있어 이 블록은 위쪽 ALTER 들 뒤에 있어야
      -- 합니다. migrate() 쪽에 두면 옛 DB 에서 "no such column" 이 납니다.
      CREATE INDEX IF NOT EXISTS idx_usage_events_effective_at
        ON usage_events(provider, COALESCE(event_timestamp, observed_at));
      CREATE INDEX IF NOT EXISTS idx_server_snapshots_window_effective_at
        ON server_usage_snapshots(
          provider, COALESCE(limit_id, 'default'), window_type,
          COALESCE(window_minutes, -1), COALESCE(event_timestamp, observed_at) DESC, id DESC);
      -- 같은 내용의 스냅샷을 걸러내는 경로. event_timestamp 를 앞에 두어야
      -- 창(window) 안 수만 건이 아니라 같은 시각의 몇 건으로 좁혀집니다.
      CREATE INDEX IF NOT EXISTS idx_server_snapshots_dedup
        ON server_usage_snapshots(
          provider, event_timestamp, window_type,
          COALESCE(limit_id, 'default'), used_percent, COALESCE(window_minutes, -1));
      -- hasUnattributedTurns 는 파일당 한 번 호출됩니다. turn_index 까지 색인에
      -- 담아 두면 원장을 열지 않고 색인만 보고 답합니다.
      CREATE INDEX IF NOT EXISTS idx_usage_events_source
        ON usage_events(provider, source_path, turn_index);
      INSERT OR IGNORE INTO provider_scan_state (
        provider, source_path, byte_offset, file_size, mtime_ms,
        last_input_tokens, last_cached_input_tokens, last_cache_write_input_tokens,
        last_output_tokens, last_reasoning_tokens, last_total_tokens, last_session_id, updated_at
      )
      SELECT 'codex', source_path, byte_offset, file_size, mtime_ms,
             last_input_tokens, last_cached_input_tokens, last_cache_write_input_tokens,
             last_output_tokens, last_reasoning_tokens, last_total_tokens, last_session_id, updated_at
      FROM scan_state;
    `);
  }

  close() {
    this.db.close();
  }

  // 배치 쓰기용. Claude 첫 스캔은 수만 건을 넣으므로 한 건씩 커밋하면
  // 느립니다. 단일 SQLite 연결을 Codex 수집기와 공유하므로 중첩 BEGIN 이
  // 나면 안 되고, 그래서 await 없는 동기 함수만 받는 것이 계약입니다.
  transaction(run) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  getScanState(provider, sourcePath) {
    const providerId = normalizeProviderId(provider);
    const row = this.db.prepare('SELECT * FROM provider_scan_state WHERE provider = ? AND source_path = ?').get(providerId, sourcePath);
    if (!row) return null;
    return {
      sourcePath,
      byteOffset: Number(row.byte_offset) || 0,
      fileSize: Number(row.file_size) || 0,
      mtimeMs: row.mtime_ms == null ? null : Number(row.mtime_ms),
      previousUsage: {
        input_tokens: Number(row.last_input_tokens) || 0,
        cached_input_tokens: Number(row.last_cached_input_tokens) || 0,
        cache_write_input_tokens: Number(row.last_cache_write_input_tokens) || 0,
        output_tokens: Number(row.last_output_tokens) || 0,
        reasoning_output_tokens: Number(row.last_reasoning_tokens) || 0,
        total_tokens: Number(row.last_total_tokens) || 0,
      },
      sessionId: row.last_session_id ?? null,
      parserVersion: row.parser_version == null ? null : Number(row.parser_version),
      contentHash: row.content_hash ?? null,
    };
  }

  saveScanState({ provider, sourcePath, byteOffset, fileSize, mtimeMs, previousUsage, sessionId, parserVersion = null, contentHash = null }) {
    const providerId = normalizeProviderId(provider);
    this.db.prepare(`
      INSERT INTO provider_scan_state (
        provider, source_path, byte_offset, file_size, mtime_ms,
        last_input_tokens, last_cached_input_tokens, last_cache_write_input_tokens,
        last_output_tokens, last_reasoning_tokens, last_total_tokens,
        last_session_id, updated_at, parser_version, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, source_path) DO UPDATE SET
        byte_offset=excluded.byte_offset,
        file_size=excluded.file_size,
        mtime_ms=excluded.mtime_ms,
        last_input_tokens=excluded.last_input_tokens,
        last_cached_input_tokens=excluded.last_cached_input_tokens,
        last_cache_write_input_tokens=excluded.last_cache_write_input_tokens,
        last_output_tokens=excluded.last_output_tokens,
        last_reasoning_tokens=excluded.last_reasoning_tokens,
        last_total_tokens=excluded.last_total_tokens,
        last_session_id=excluded.last_session_id,
        updated_at=excluded.updated_at,
        parser_version=excluded.parser_version,
        content_hash=excluded.content_hash
    `).run(
      providerId,
      sourcePath,
      byteOffset,
      fileSize,
      mtimeMs,
      previousUsage.inputTokens ?? previousUsage.input_tokens ?? 0,
      previousUsage.cachedInputTokens ?? previousUsage.cached_input_tokens ?? 0,
      previousUsage.cacheWriteInputTokens ?? previousUsage.cache_write_input_tokens ?? 0,
      previousUsage.outputTokens ?? previousUsage.output_tokens ?? 0,
      previousUsage.reasoningTokens ?? previousUsage.reasoning_output_tokens ?? 0,
      previousUsage.totalTokens ?? previousUsage.total_tokens ?? 0,
      sessionId,
      isoNow(),
      parserVersion,
      contentHash,
    );
  }

  resetScanState(provider, sourcePath) {
    this.db.prepare('DELETE FROM provider_scan_state WHERE provider = ? AND source_path = ?')
      .run(normalizeProviderId(provider), sourcePath);
  }

  upsertSession(session, sourcePath, observedAt = isoNow()) {
    const sessionId = session.sessionId;
    if (!sessionId) return;
    const provider = normalizeProviderId(session.provider);
    this.db.prepare(`
      INSERT INTO sessions (
        provider, session_id, source_path, cwd, project_name, model, model_provider,
        cli_version, source, git_sha, git_branch, git_origin_url, started_at,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, session_id) DO UPDATE SET
        source_path=excluded.source_path,
        cwd=COALESCE(excluded.cwd, sessions.cwd),
        project_name=CASE WHEN excluded.project_name IS NULL OR excluded.project_name = 'unknown-project' THEN sessions.project_name ELSE excluded.project_name END,
        model=COALESCE(excluded.model, sessions.model),
        model_provider=COALESCE(excluded.model_provider, sessions.model_provider),
        cli_version=COALESCE(excluded.cli_version, sessions.cli_version),
        source=COALESCE(excluded.source, sessions.source),
        git_sha=COALESCE(excluded.git_sha, sessions.git_sha),
        git_branch=COALESCE(excluded.git_branch, sessions.git_branch),
        git_origin_url=COALESCE(excluded.git_origin_url, sessions.git_origin_url),
        started_at=COALESCE(excluded.started_at, sessions.started_at),
        last_seen_at=excluded.last_seen_at
    `).run(
      provider, sessionId, sourcePath,
      session.cwd ?? null,
      session.projectName ?? projectNameFromCwd(session.cwd),
      session.model ?? null,
      session.modelProvider ?? null,
      session.cliVersion ?? null,
      session.source ?? null,
      session.gitSha ?? null,
      session.gitBranch ?? null,
      session.gitOriginUrl ?? null,
      session.startedAt ?? null,
      observedAt,
      observedAt,
    );
  }

  getSession(provider, sessionId) {
    if (!sessionId) return null;
    const row = this.db.prepare(`
      SELECT provider, session_id, cwd, project_name, model, model_provider, cli_version,
             source, git_sha, git_branch, git_origin_url, started_at
      FROM sessions WHERE provider = ? AND session_id = ?
    `).get(provider, sessionId);
    if (!row) return null;
    return {
      provider: row.provider,
      sessionId: row.session_id,
      cwd: row.cwd,
      projectName: row.project_name,
      model: row.model,
      modelProvider: row.model_provider,
      cliVersion: row.cli_version,
      source: row.source,
      gitSha: row.git_sha,
      gitBranch: row.git_branch,
      gitOriginUrl: row.git_origin_url,
      startedAt: row.started_at,
    };
  }

  // 요청 행에 달리는 구조 메타(docs/dev/menus/session.md). 파서가 주지
  // 않으면 null 로 들어가고, 세션 화면은 그런 요청을 "경계 미확인"
  // 버킷(턴 0번)으로 모읍니다.
  static #turnMeta(event) {
    const toolCounts = event.toolCounts && Object.keys(event.toolCounts).length
      ? JSON.stringify(event.toolCounts) : null;
    const touchedPaths = event.touchedPaths && Object.keys(event.touchedPaths).length
      ? JSON.stringify(event.touchedPaths) : null;
    const turnIndex = Number.isInteger(event.turnIndex) ? event.turnIndex : null;
    return { turnIndex, toolCounts, touchedPaths };
  }

  insertUsageEvent(event, sourcePath, sourceOffset, observedAt = isoNow()) {
    const session = event.session;
    const provider = normalizeProviderId(event.provider ?? session?.provider);
    this.upsertSession(session, sourcePath, observedAt);
    const usage = event.delta;
    const eventKey = event.eventKey ?? stableEventKey(
      provider, session.sessionId, event.eventTimestamp, session.model, usage,
    );
    // 두 갈래를 OR 하나로 묶으면 SQLite 가 어느 색인도 못 쓰고 원장을 전수
    // 훑습니다. 원장이 커질수록 삽입 한 건이 비싸져 첫 백필이 O(n²) 가 됩니다
    // (실측: 건당 6.3ms, 1.9만 건에 120초). 갈래를 나눠 각자 색인을 타게 합니다.
    if (eventKey) {
      const keyMatch = this.db.prepare(`
        SELECT 1 FROM usage_events WHERE provider = ? AND event_key = ? LIMIT 1
      `).get(provider, eventKey);
      if (keyMatch) return false;
      // event_key 가 없던 시절에 쌓인 행은 위 조회로 안 걸립니다. 같은 내용인지
      // 필드로 직접 견줍니다 — 키가 바로 이 필드들로 만들어지므로 이 비교는
      // 키 비교와 같은 뜻입니다. 앞의 세 컬럼이 idx_usage_events_session 과
      // 맞아 같은 세션·같은 시각의 몇 건으로 좁혀집니다.
      const shapeMatch = this.db.prepare(`
        SELECT 1 FROM usage_events
        WHERE provider = ? AND session_id = ? AND event_timestamp = ?
          AND COALESCE(model, '') = COALESCE(?, '')
          AND input_tokens = ? AND cached_input_tokens = ? AND cache_write_input_tokens = ?
          AND output_tokens = ? AND reasoning_tokens = ? AND total_tokens = ?
        LIMIT 1
      `).get(
        provider, session.sessionId, event.eventTimestamp, session.model ?? null,
        usage.inputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens,
        usage.outputTokens, usage.reasoningTokens, usage.totalTokens,
      );
      if (shapeMatch) return false;
    }
    const measurementSource = event.measurementSource ?? 'local_log';
    const measurementQuality = event.measurementQuality ?? 'local_exact';
    const turnMeta = UsageStore.#turnMeta(event);
    // tool_tokens / field_quality / parser_version / request_id 는 오랫동안 이
    // 목록에서 빠져 있었습니다. 파서는 넷 다 실어 보내는데 이 경로로 들어온 행은
    // 넷이 전부 NULL 이 됐고, 그래서 "모든 이벤트가 parser_version 을 남긴다"는
    // 계약이 이 경로를 쓰는 provider(codex)에서만 거짓이었습니다. upsert 경로는
    // 처음부터 넷을 다 씁니다 — 두 경로가 같은 열을 채우게 맞춥니다.
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO usage_events (
        provider, session_id, source_path, source_offset, event_timestamp, observed_at,
        cwd, project_name, model,
        input_tokens, cached_input_tokens, cache_write_input_tokens,
        output_tokens, reasoning_tokens, tool_tokens, total_tokens, cumulative_reset,
        measurement_source, measurement_quality, event_key,
        field_quality, parser_version, request_id,
        turn_index, tool_counts, touched_paths
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      provider, session.sessionId, sourcePath, sourceOffset,
      event.eventTimestamp ?? null, observedAt,
      session.cwd ?? null, session.projectName ?? projectNameFromCwd(session.cwd), session.model ?? null,
      usage.inputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens,
      usage.outputTokens, usage.reasoningTokens, usage.toolTokens ?? 0, usage.totalTokens,
      event.cumulativeReset ? 1 : 0,
      measurementSource, measurementQuality, eventKey,
      event.fieldQuality ? JSON.stringify(event.fieldQuality) : null,
      event.parserVersion ?? null, event.requestId ?? null,
      turnMeta.turnIndex, turnMeta.toolCounts, turnMeta.touchedPaths,
    );
    return Number(result.changes) > 0;
  }

  // Claude 전용 저장 경로. Codex 는 append-only 가정이 맞으므로
  // insertUsageEvent() 를 계속 씁니다 — provider 가 자기 저장 전략을 고르는
  // 구조이지, 전역 동작을 바꾸는 것이 아닙니다(docs/dev/store-extensions.md §1).
  //
  // 같은 event_key 가 다시 오는 상황은 둘입니다.
  //   1) 같은 요청이 여러 줄로 나뉘어 기록된다 (content block 단위 분할)
  //   2) 세션을 resume 하면 이전 transcript 가 새 파일로 복사된다
  // 둘 다 last-wins 로 합칩니다(R1). 단, 2)의 사본은 사용량이 0 으로 남을 수
  // 있어(실측 1건) 후행 레코드가 역행하면 덮지 않습니다. 한 파일 안에서는
  // 역행이 실측 0건이므로 이 가드는 last-wins 의미를 바꾸지 않고 resume
  // 사본만 걸러냅니다.
  upsertUsageEvent(event, sourcePath, sourceOffset, observedAt = isoNow()) {
    const session = event.session;
    const provider = normalizeProviderId(event.provider ?? session?.provider);
    const eventKey = event.eventKey;
    if (!eventKey) throw new TypeError(`${provider}: upsertUsageEvent requires a stable eventKey`);
    this.upsertSession(session, sourcePath, observedAt);
    const usage = event.delta;
    const fieldQuality = event.fieldQuality ? JSON.stringify(event.fieldQuality) : null;
    const measurementSource = event.measurementSource ?? 'local_log';
    const measurementQuality = event.measurementQuality ?? 'local_exact';
    const turnMeta = UsageStore.#turnMeta(event);

    const existing = this.db.prepare(
      'SELECT id, total_tokens FROM usage_events WHERE provider = ? AND event_key = ?',
    ).get(provider, eventKey);

    if (existing) {
      // 집계에 쓰는 것이 total 이므로 total 로 판정합니다. 같거나 작으면
      // 이미 본 값을 다시 읽은 것(또는 resume 사본)이니 쓰기를 생략합니다.
      // 더 작으면 resume 사본이거나 낡은 관측이므로 덮지 않습니다.
      // 같으면 같은 레코드를 다시 읽은 것이라 토큰은 그대로지만, 파서가
      // 버전업돼 새로 붙는 메타(턴 번호·도구 이름)를 채워야 하므로 통과시킵니다.
      if (usage.totalTokens < Number(existing.total_tokens)) {
        return { changed: false, inserted: false, updated: false, reason: 'stale' };
      }
      // source_path/source_offset 은 최초에 관측한 값을 유지합니다
      // — UNIQUE(provider, source_path, source_offset) 가 남아 있어 갱신하면
      // 새 행이 생깁니다(docs/dev/store-extensions.md §1).
      this.db.prepare(`
        UPDATE usage_events SET
          event_timestamp = COALESCE(?, event_timestamp),
          observed_at = ?,
          cwd = COALESCE(?, cwd),
          project_name = CASE WHEN ? IS NULL OR ? = 'unknown-project' THEN project_name ELSE ? END,
          model = COALESCE(?, model),
          input_tokens = ?, cached_input_tokens = ?, cache_write_input_tokens = ?,
          output_tokens = ?, reasoning_tokens = ?, tool_tokens = ?, total_tokens = ?,
          measurement_source = ?, measurement_quality = ?,
          field_quality = ?, parser_version = ?, request_id = COALESCE(?, request_id),
          turn_index = COALESCE(?, turn_index),
          tool_counts = COALESCE(?, tool_counts),
          touched_paths = COALESCE(?, touched_paths)
        WHERE id = ?
      `).run(
        event.eventTimestamp ?? null,
        observedAt,
        session.cwd ?? null,
        session.projectName ?? null, session.projectName ?? null, session.projectName ?? null,
        session.model ?? null,
        usage.inputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens,
        usage.outputTokens, usage.reasoningTokens, usage.toolTokens ?? 0, usage.totalTokens,
        measurementSource, measurementQuality,
        fieldQuality, event.parserVersion ?? null, event.requestId ?? null,
        turnMeta.turnIndex, turnMeta.toolCounts, turnMeta.touchedPaths,
        existing.id,
      );
      return { changed: true, inserted: false, updated: true };
    }

    // 이 offset 에 이미 다른 event_key 가 있다면 파일이 제자리에서 고쳐진
    // 경우이므로 새 관측으로 대체합니다.
    this.db.prepare(`
      INSERT INTO usage_events (
        provider, session_id, source_path, source_offset, event_timestamp, observed_at,
        cwd, project_name, model,
        input_tokens, cached_input_tokens, cache_write_input_tokens,
        output_tokens, reasoning_tokens, tool_tokens, total_tokens, cumulative_reset,
        measurement_source, measurement_quality, event_key, field_quality, parser_version, request_id,
        turn_index, tool_counts, touched_paths
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, source_path, source_offset) DO UPDATE SET
        event_timestamp=excluded.event_timestamp,
        observed_at=excluded.observed_at,
        cwd=excluded.cwd,
        project_name=excluded.project_name,
        model=excluded.model,
        input_tokens=excluded.input_tokens,
        cached_input_tokens=excluded.cached_input_tokens,
        cache_write_input_tokens=excluded.cache_write_input_tokens,
        output_tokens=excluded.output_tokens,
        reasoning_tokens=excluded.reasoning_tokens,
        tool_tokens=excluded.tool_tokens,
        total_tokens=excluded.total_tokens,
        measurement_source=excluded.measurement_source,
        measurement_quality=excluded.measurement_quality,
        event_key=excluded.event_key,
        field_quality=excluded.field_quality,
        parser_version=excluded.parser_version,
        request_id=excluded.request_id,
        turn_index=excluded.turn_index,
        tool_counts=excluded.tool_counts,
        touched_paths=excluded.touched_paths
    `).run(
      provider, session.sessionId, sourcePath, sourceOffset,
      event.eventTimestamp ?? null, observedAt,
      session.cwd ?? null, session.projectName ?? projectNameFromCwd(session.cwd), session.model ?? null,
      usage.inputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens,
      usage.outputTokens, usage.reasoningTokens, usage.toolTokens ?? 0, usage.totalTokens,
      event.cumulativeReset ? 1 : 0,
      measurementSource, measurementQuality, eventKey,
      fieldQuality, event.parserVersion ?? null, event.requestId ?? null,
      turnMeta.turnIndex, turnMeta.toolCounts, turnMeta.touchedPaths,
    );
    return { changed: true, inserted: true, updated: false };
  }

  insertRateLimits(event, sourcePath, sourceOffset, observedAt = isoNow()) {
    const provider = normalizeProviderId(event.provider ?? event.session?.provider);
    const limitId = normalizeLimitId(event.rateLimits.limitId ?? provider);
    const inserted = [];
    const windows = [
      ['primary', event.rateLimits.primary],
      ['secondary', event.rateLimits.secondary],
    ];
    for (const [windowType, window] of windows) {
      if (!window) continue;
      const snapshotKey = stableSnapshotKey(
        provider, event.session?.sessionId, event.eventTimestamp, limitId, windowType, window,
      );
      // 두 갈래를 OR 하나로 묶으면 SQLite 가 어느 색인도 못 쓰고 전수 훑기로
      // 떨어집니다. 갈래별로 나눠 각자 자기 색인을 타게 합니다.
      if (snapshotKey) {
        const keyMatch = this.db.prepare(`
          SELECT 1 FROM server_usage_snapshots
          WHERE provider = ? AND snapshot_key = ? LIMIT 1
        `).get(provider, snapshotKey);
        if (keyMatch) continue;
        // snapshot_key 가 없던 시절에 쌓인 행은 위 조회로 안 걸립니다. 같은
        // 내용인지 필드로 직접 견줍니다 — 키가 바로 이 필드들로 만들어지므로
        // 이 비교는 키 비교와 같은 뜻입니다.
        const shapeMatch = this.db.prepare(`
          SELECT 1 FROM server_usage_snapshots
          WHERE provider = ? AND event_timestamp = ? AND window_type = ?
            AND COALESCE(limit_id, 'default') = ?
            AND used_percent = ?
            AND COALESCE(window_minutes, -1) = COALESCE(?, -1)
            AND COALESCE(session_id, '') = COALESCE(?, '')
            AND COALESCE(resets_at, -1) = COALESCE(?, -1)
          LIMIT 1
        `).get(
          provider, event.eventTimestamp, windowType, limitId,
          window.usedPercent, window.windowMinutes,
          event.session?.sessionId ?? null, window.resetsAt,
        );
        if (shapeMatch) continue;
      }
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO server_usage_snapshots (
          provider, session_id, source_path, source_offset, event_timestamp, observed_at,
          limit_id, limit_name, window_type, used_percent, window_minutes, resets_at,
          measurement_source, snapshot_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        provider, event.session?.sessionId ?? null, sourcePath, sourceOffset,
        event.eventTimestamp ?? null, observedAt,
        limitId, event.rateLimits.limitName ?? null,
        windowType, window.usedPercent, window.windowMinutes, window.resetsAt,
        event.measurementSource ?? 'server_snapshot', snapshotKey,
      );
      if (Number(result.changes) > 0) {
        inserted.push(windowType);
        this.reconcileLatestWindow(provider, limitId, windowType, window.windowMinutes);
      }
    }
    return inserted;
  }

  reconcileLatestWindow(provider, limitId, windowType, windowMinutes = null) {
    const normalizedLimitId = normalizeLimitId(limitId);
    const normalizedWindowMinutes = Number.isFinite(Number(windowMinutes)) ? Number(windowMinutes) : -1;
    const rows = this.db.prepare(`
      SELECT COALESCE(event_timestamp, observed_at) AS snapshot_at, used_percent, resets_at
      FROM server_usage_snapshots
      WHERE provider = ? AND COALESCE(limit_id, 'default') = ? AND window_type = ?
        AND COALESCE(window_minutes, -1) = ?
      ORDER BY COALESCE(event_timestamp, observed_at) DESC, id DESC LIMIT 2
    `).all(provider, normalizedLimitId, windowType, normalizedWindowMinutes);
    if (rows.length < 2) return null;
    const current = rows[0];
    const previous = rows[1];
    const resetChanged = current.resets_at != null && previous.resets_at != null && current.resets_at !== previous.resets_at;
    const serverDelta = Number(current.used_percent) - Number(previous.used_percent);
    const local = this.db.prepare(`
      SELECT COALESCE(SUM(total_tokens), 0) AS total
      FROM usage_events
      WHERE provider = ?
        AND COALESCE(event_timestamp, observed_at) > ?
        AND COALESCE(event_timestamp, observed_at) <= ?
    `).get(provider, previous.snapshot_at, current.snapshot_at);
    const localTokenDelta = Number(local?.total) || 0;

    let classification = 'UNKNOWN';
    let confidence = 'low';
    if (resetChanged || serverDelta < -0.01) {
      classification = 'RESET';
      confidence = 'high';
    } else if (serverDelta > 0.01 && localTokenDelta > 0) {
      classification = 'MATCHED_ACTIVITY';
      confidence = 'medium';
    } else if (serverDelta > 0.01 && localTokenDelta === 0) {
      classification = 'SERVER_ONLY_CHANGE';
      confidence = 'high';
    } else if (Math.abs(serverDelta) <= 0.01 && localTokenDelta > 0) {
      classification = 'LOCAL_ONLY_ACTIVITY';
      confidence = 'medium';
    }

    this.db.prepare(`
      INSERT OR IGNORE INTO reconciliation_events (
        provider, limit_id, window_type, window_minutes, from_observed_at, to_observed_at,
        server_usage_delta, local_token_delta, classification, confidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      provider, normalizedLimitId, windowType, normalizedWindowMinutes, previous.snapshot_at, current.snapshot_at,
      serverDelta, localTokenDelta, classification, confidence, isoNow(),
    );
    return { limitId: normalizedLimitId, windowType, windowMinutes: normalizedWindowMinutes, serverDelta, localTokenDelta, classification, confidence };
  }

  getLatestRateLimits(provider = 'codex') {
    const rows = this.db.prepare(`
      SELECT used_percent, window_minutes, resets_at, window_type,
             COALESCE(event_timestamp, observed_at) AS snapshot_at,
             COALESCE(limit_id, 'default') AS limit_id, limit_name
      FROM server_usage_snapshots
      WHERE provider = ?
      ORDER BY COALESCE(event_timestamp, observed_at) DESC, id DESC
    `).all(provider);
    const limits = new Map();
    const seenWindows = new Set();
    for (const row of rows) {
      const limitId = normalizeLimitId(row.limit_id);
      const windowKey = `${limitId}:${row.window_type}`;
      if (seenWindows.has(windowKey)) continue;
      seenWindows.add(windowKey);
      if (!limits.has(limitId)) {
        limits.set(limitId, { limitId, limitName: row.limit_name, windows: {} });
      }
      const limit = limits.get(limitId);
      limit.limitName ??= row.limit_name;
      limit.windows[row.window_type] = {
        windowType: row.window_type,
        usedPercent: Number(row.used_percent),
        windowMinutes: row.window_minutes == null ? null : Number(row.window_minutes),
        resetsAt: row.resets_at == null ? null : Number(row.resets_at),
        observedAt: row.snapshot_at,
        limitId,
        limitName: limit.limitName,
      };
    }
    const list = [...limits.values()];
    const defaultLimit = list.find((limit) => limit.limitId === normalizeLimitId(provider)) ?? list[0] ?? null;
    return {
      limits: list,
      primary: defaultLimit?.windows.primary ?? null,
      secondary: defaultLimit?.windows.secondary ?? null,
    };
  }

  getProviderTotals(provider = 'codex', since = null) {
    const where = since ? 'WHERE provider = ? AND COALESCE(event_timestamp, observed_at) >= ?' : 'WHERE provider = ?';
    const args = since ? [provider, since] : [provider];
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens),0) AS cached_input_tokens,
        COALESCE(SUM(cache_write_input_tokens),0) AS cache_write_input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
        COALESCE(SUM(total_tokens),0) AS total_tokens,
        COUNT(*) AS event_count
      FROM usage_events ${where}
    `).get(...args);
    return {
      inputTokens: Number(row.input_tokens) || 0,
      cachedInputTokens: Number(row.cached_input_tokens) || 0,
      cacheWriteInputTokens: Number(row.cache_write_input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      reasoningTokens: Number(row.reasoning_tokens) || 0,
      totalTokens: Number(row.total_tokens) || 0,
      eventCount: Number(row.event_count) || 0,
    };
  }

  // 품질 배지용 집계. field_quality 는 provider 당 가짓수가 적어 그룹해서
  // 꺼내고 JS 에서 병합합니다 — 매 행을 JSON.parse 하지 않기 위해서입니다.
  getProviderQuality(provider, since = null) {
    const where = since
      ? 'WHERE provider = ? AND COALESCE(event_timestamp, observed_at) >= ?'
      : 'WHERE provider = ?';
    const args = since ? [provider, since] : [provider];
    const rows = this.db.prepare(`
      SELECT measurement_quality, measurement_source, field_quality,
             COUNT(*) AS event_count, COALESCE(SUM(total_tokens),0) AS total_tokens
      FROM usage_events ${where}
      GROUP BY measurement_quality, measurement_source, field_quality
    `).all(...args);

    const byQuality = {};
    const sources = {};
    const fields = {};
    let overall = null;
    let eventCount = 0;
    for (const row of rows) {
      const quality = row.measurement_quality ?? 'unverified';
      const events = Number(row.event_count) || 0;
      const tokens = Number(row.total_tokens) || 0;
      eventCount += events;
      byQuality[quality] ??= { eventCount: 0, totalTokens: 0 };
      byQuality[quality].eventCount += events;
      byQuality[quality].totalTokens += tokens;
      sources[row.measurement_source ?? 'local_log'] = (sources[row.measurement_source ?? 'local_log'] ?? 0) + events;
      overall = worstQuality(overall, quality);
      if (!row.field_quality) continue;
      let parsed;
      try { parsed = JSON.parse(row.field_quality); } catch { continue; }
      for (const [field, grade] of Object.entries(parsed ?? {})) {
        const entry = fields[field] ??= { worst: null, counts: {} };
        entry.worst = worstQuality(entry.worst, grade);
        entry.counts[grade] = (entry.counts[grade] ?? 0) + events;
      }
    }
    // 최저 등급만 보여주면 이벤트 1건 때문에 필드 전체가 "추정"으로 보이므로
    // 등급별 건수를 함께 넣어 UI 가 "대부분 로컬 관측, 9건 추정"처럼 적을 수
    // 있게 합니다. field_quality 에 없는 필드는 "0 토큰"이 아니라
    // "미제공"입니다(R7).
    return { overall, eventCount, byQuality, sources, fields, reportedFields: Object.keys(fields) };
  }

  // "최근" 목록이므로 마지막 활동 순입니다. 토큰 순으로 두면 몇 주 전의 큰
  // 프로젝트가 LIMIT 자리를 계속 차지해 오늘 만진 프로젝트가 아예 안 보입니다.
  // 토큰 순위는 프로젝트 화면(getProjectBreakdown)이 맡습니다 — 두 화면의
  // 정렬 기준이 다른 것이 의도입니다.
  // 마지막 활동이 같은 초인 프로젝트는 흔합니다. 그 동률을 GROUP BY 임시
  // b-tree 가 내주는 순서에 맡기면 같은 데이터인데도 새로고침마다 목록이
  // 뒤바뀌므로, 세션 목록(getProjectSessions)이 암묵적으로 기대던 그룹 키 순을
  // 여기서는 명시합니다. 보조 키를 토큰으로 두면 토큰 순위가 슬쩍 되살아납니다.
  getRecentProjects(provider = 'codex', limit = 6, since = null) {
    const timeClause = since ? 'AND COALESCE(event_timestamp, observed_at) >= ?' : '';
    const args = since ? [provider, since, limit] : [provider, limit];
    const rows = this.db.prepare(`
      SELECT
        COALESCE(NULLIF(project_name,''), 'unknown-project') AS project_name,
        MAX(cwd) AS cwd,
        COALESCE(SUM(total_tokens),0) AS total_tokens,
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens),0) AS cached_input_tokens,
        MAX(COALESCE(event_timestamp, observed_at)) AS last_activity,
        MAX(model) AS model
      FROM usage_events
      WHERE provider = ? ${timeClause}
      GROUP BY project_name
      ORDER BY last_activity DESC, project_name ASC
      LIMIT ?
    `).all(...args);
    return rows.map((row) => ({
      name: row.project_name,
      cwd: row.cwd,
      model: row.model,
      totalTokens: Number(row.total_tokens) || 0,
      inputTokens: Number(row.input_tokens) || 0,
      cachedInputTokens: Number(row.cached_input_tokens) || 0,
      lastActivity: row.last_activity,
    }));
  }

  // 정렬 규칙은 위 getRecentProjects 와 같습니다 — 동률은 그룹 키 순입니다.
  getRecentProjectsAcrossProviders(limit = 6, since = null) {
    const timeClause = since ? 'WHERE COALESCE(event_timestamp, observed_at) >= ?' : '';
    const args = since ? [since, limit] : [limit];
    const rows = this.db.prepare(`
      SELECT
        provider,
        COALESCE(NULLIF(project_name,''), 'unknown-project') AS project_name,
        MAX(cwd) AS cwd,
        COALESCE(SUM(total_tokens),0) AS total_tokens,
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens),0) AS cached_input_tokens,
        MAX(COALESCE(event_timestamp, observed_at)) AS last_activity,
        MAX(model) AS model
      FROM usage_events
      ${timeClause}
      GROUP BY provider, project_name
      ORDER BY last_activity DESC, provider ASC, project_name ASC
      LIMIT ?
    `).all(...args);
    const aliases = this.#aliasIndex();
    return rows.map((row) => this.#applyProjectPrivacy({
      provider: row.provider,
      name: row.project_name,
      cwd: row.cwd,
      model: row.model,
      totalTokens: Number(row.total_tokens) || 0,
      inputTokens: Number(row.input_tokens) || 0,
      cachedInputTokens: Number(row.cached_input_tokens) || 0,
      lastActivity: row.last_activity,
    }, aliases));
  }

  getRecentReconciliation(provider = 'codex', limit = 12) {
    return this.db.prepare(`
      SELECT limit_id, window_type, window_minutes, from_observed_at, to_observed_at, server_usage_delta,
             local_token_delta, classification, confidence
      FROM reconciliation_events
      WHERE provider = ?
      ORDER BY to_observed_at DESC LIMIT ?
    `).all(provider, limit).map((row) => ({
      limitId: row.limit_id,
      windowType: row.window_type,
      windowMinutes: Number(row.window_minutes),
      from: row.from_observed_at,
      to: row.to_observed_at,
      serverUsageDelta: row.server_usage_delta == null ? null : Number(row.server_usage_delta),
      localTokenDelta: Number(row.local_token_delta) || 0,
      classification: row.classification,
      confidence: row.confidence,
    }));
  }

  // ---- M2 집계 계층 ----------------------------------------------------
  // 버킷 경계는 반드시 로컬 시간대로 끊습니다. 엔진이 월 합계를
  // startOfLocalMonthIso()로 계산하므로, 여기서 UTC로 끊으면 이 화면의 월
  // 합계가 대시보드 총합과 어긋납니다(docs/dev/menus/usage.md).
  static BUCKET_FORMATS = Object.freeze({
    hour: '%Y-%m-%dT%H:00',
    day: '%Y-%m-%d',
    week: '%Y-W%W',
    month: '%Y-%m',
  });

  #tokenSums(prefix = '') {
    return `
      COALESCE(SUM(${prefix}input_tokens),0) AS input_tokens,
      COALESCE(SUM(${prefix}cached_input_tokens),0) AS cached_input_tokens,
      COALESCE(SUM(${prefix}cache_write_input_tokens),0) AS cache_write_input_tokens,
      COALESCE(SUM(${prefix}output_tokens),0) AS output_tokens,
      COALESCE(SUM(${prefix}reasoning_tokens),0) AS reasoning_tokens,
      COALESCE(SUM(${prefix}total_tokens),0) AS total_tokens,
      COUNT(*) AS event_count
    `;
  }

  #tokensFrom(row) {
    return {
      inputTokens: Number(row.input_tokens) || 0,
      cachedInputTokens: Number(row.cached_input_tokens) || 0,
      cacheWriteInputTokens: Number(row.cache_write_input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      reasoningTokens: Number(row.reasoning_tokens) || 0,
      totalTokens: Number(row.total_tokens) || 0,
      eventCount: Number(row.event_count) || 0,
    };
  }

  #usageFilter({ provider = null, model = null, since = null, until = null } = {}) {
    const clauses = [];
    const args = [];
    if (provider) { clauses.push('provider = ?'); args.push(provider); }
    if (model) { clauses.push('model = ?'); args.push(model); }
    if (since) { clauses.push('COALESCE(event_timestamp, observed_at) >= ?'); args.push(since); }
    if (until) { clauses.push('COALESCE(event_timestamp, observed_at) < ?'); args.push(until); }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args };
  }

  getUsageTimeseries({ provider = null, model = null, bucket = 'day', since = null, until = null } = {}) {
    const format = UsageStore.BUCKET_FORMATS[bucket] ?? UsageStore.BUCKET_FORMATS.day;
    const resolvedBucket = UsageStore.BUCKET_FORMATS[bucket] ? bucket : 'day';
    const { where, args } = this.#usageFilter({ provider, model, since, until });
    const rows = this.db.prepare(`
      SELECT
        strftime('${format}', COALESCE(event_timestamp, observed_at), 'localtime') AS bucket_start,
        provider,
        ${this.#tokenSums()}
      FROM usage_events
      ${where}
      GROUP BY bucket_start, provider
      ORDER BY bucket_start ASC, provider ASC
    `).all(...args);
    return {
      bucket: resolvedBucket,
      series: rows.map((row) => ({
        bucketStart: row.bucket_start,
        provider: row.provider,
        tokens: this.#tokensFrom(row),
      })),
    };
  }

  getModelBreakdown({ provider = null, since = null, until = null } = {}) {
    const { where, args } = this.#usageFilter({ provider, since, until });
    const rows = this.db.prepare(`
      SELECT provider, COALESCE(NULLIF(model,''), '(모델 미기록)') AS model, ${this.#tokenSums()}
      FROM usage_events
      ${where}
      GROUP BY provider, model
      ORDER BY total_tokens DESC
    `).all(...args);
    const grandTotal = rows.reduce((sum, row) => sum + (Number(row.total_tokens) || 0), 0);
    return {
      totalTokens: grandTotal,
      models: rows.map((row) => {
        const tokens = this.#tokensFrom(row);
        return {
          provider: row.provider,
          model: row.model,
          tokens,
          share: grandTotal > 0 ? tokens.totalTokens / grandTotal : 0,
        };
      }),
    };
  }

  getProjectAliases() {
    return this.db.prepare('SELECT provider, project_key, alias, redacted FROM project_aliases').all().map((row) => ({
      provider: row.provider,
      projectKey: row.project_key,
      alias: row.alias,
      redacted: Number(row.redacted) === 1,
    }));
  }

  setProjectAlias({ provider, projectKey, alias = null, redacted = false }) {
    if (!provider || !projectKey) throw new TypeError('provider and projectKey are required');
    this.db.prepare(`
      INSERT INTO project_aliases (provider, project_key, alias, redacted, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider, project_key) DO UPDATE SET
        alias = excluded.alias, redacted = excluded.redacted, updated_at = excluded.updated_at
    `).run(provider, projectKey, alias ?? '', redacted ? 1 : 0, isoNow());
    return this.getProjectAliases().find((row) => row.provider === provider && row.projectKey === projectKey) ?? null;
  }

  #aliasIndex() {
    const index = new Map();
    for (const row of this.getProjectAliases()) index.set(`${row.provider}|${row.projectKey}`, row);
    return index;
  }

  // 가림은 서비스가 응답을 만들 때 적용합니다. 클라이언트에서 가리면 원본
  // 경로가 HTTP 응답에 그대로 남습니다(docs/dev/menus/project.md).
  #applyProjectPrivacy(project, aliases = this.#aliasIndex()) {
    const projectKey = projectKeyOf(project.provider, project.name);
    const alias = aliases.get(`${project.provider}|${projectKey}`) ?? null;
    if (alias?.redacted) {
      return { ...project, projectKey, name: alias.alias || `(가림) ${projectKey.slice(0, 4)}`, cwd: null, redacted: true, alias: alias.alias || null };
    }
    return { ...project, projectKey, name: alias?.alias || project.name, cwd: project.cwd ?? null, redacted: false, alias: alias?.alias || null };
  }

  getProjectBreakdown({ provider = null, since = null, until = null, limit = 100 } = {}) {
    const { where, args } = this.#usageFilter({ provider, since, until });
    const rows = this.db.prepare(`
      SELECT
        provider,
        COALESCE(NULLIF(project_name,''), '(미분류)') AS project_name,
        MAX(cwd) AS cwd,
        MAX(model) AS model,
        COUNT(DISTINCT session_id) AS session_count,
        COUNT(DISTINCT model) AS model_count,
        MAX(COALESCE(event_timestamp, observed_at)) AS last_activity,
        ${this.#tokenSums()}
      FROM usage_events
      ${where}
      GROUP BY provider, project_name
      ORDER BY total_tokens DESC
      LIMIT ?
    `).all(...args, limit);
    const aliases = this.#aliasIndex();
    return rows.map((row) => this.#applyProjectPrivacy({
      provider: row.provider,
      name: row.project_name,
      cwd: row.cwd,
      model: row.model,
      sessionCount: Number(row.session_count) || 0,
      modelCount: Number(row.model_count) || 0,
      lastActivity: row.last_activity,
      tokens: this.#tokensFrom(row),
      totalTokens: Number(row.total_tokens) || 0,
    }, aliases));
  }

  // project_key는 해시라 SQL에서 역산할 수 없습니다. 그룹 목록에서 해시를
  // 계산해 대조합니다 — 프로젝트 수가 수십 단위라 비용이 무시할 수준입니다.
  #resolveProjectKey(projectKey) {
    const rows = this.db.prepare(`
      SELECT DISTINCT provider, COALESCE(NULLIF(project_name,''), '(미분류)') AS project_name FROM usage_events
    `).all();
    return rows
      .map((row) => ({ provider: row.provider, name: row.project_name }))
      .find((row) => projectKeyOf(row.provider, row.name) === projectKey) ?? null;
  }

  getProjectDetail({ projectKey, since = null, until = null } = {}) {
    const target = this.#resolveProjectKey(projectKey);
    if (!target) return null;
    const [project] = this.getProjectBreakdown({ provider: target.provider, since, until, limit: 1000 })
      .filter((row) => row.projectKey === projectKey);
    if (!project) return null;
    const { where, args } = this.#usageFilter({ provider: target.provider, since, until });
    const scoped = where ? `${where} AND project_name = ?` : 'WHERE project_name = ?';
    const nameArg = target.name === '(미분류)' ? '' : target.name;
    const models = this.db.prepare(`
      SELECT COALESCE(NULLIF(model,''), '(모델 미기록)') AS model, ${this.#tokenSums()}
      FROM usage_events ${scoped}
      GROUP BY model ORDER BY total_tokens DESC
    `).all(...args, nameArg);
    const total = models.reduce((sum, row) => sum + (Number(row.total_tokens) || 0), 0);
    return {
      project,
      models: models.map((row) => ({
        model: row.model,
        tokens: this.#tokensFrom(row),
        share: total > 0 ? (Number(row.total_tokens) || 0) / total : 0,
      })),
      sessions: this.getProjectSessions({ projectKey, since, until }),
    };
  }

  getProjectSessions({ projectKey, since = null, until = null, limit = 20 } = {}) {
    const target = this.#resolveProjectKey(projectKey);
    if (!target) return [];
    const { where, args } = this.#usageFilter({ provider: target.provider, since, until });
    const scoped = where ? `${where} AND project_name = ?` : 'WHERE project_name = ?';
    const nameArg = target.name === '(미분류)' ? '' : target.name;
    return this.db.prepare(`
      SELECT session_id, MAX(model) AS model,
             MAX(COALESCE(event_timestamp, observed_at)) AS last_activity,
             ${this.#tokenSums()}
      FROM usage_events ${scoped}
      GROUP BY session_id
      ORDER BY last_activity DESC
      LIMIT ?
    `).all(...args, nameArg, limit).map((row) => ({
      sessionId: row.session_id,
      model: row.model,
      lastActivity: row.last_activity,
      tokens: this.#tokensFrom(row),
      totalTokens: Number(row.total_tokens) || 0,
    }));
  }

  // 한도 이력은 percent 시계열입니다. 토큰과 같은 축에 두지 않습니다(R5).
  getQuotaHistory({ provider = 'codex', limitId = null, windowMinutes = null, since = null, limit = 500 } = {}) {
    const clauses = ['provider = ?'];
    const args = [provider];
    if (limitId) { clauses.push('limit_id = ?'); args.push(limitId); }
    if (windowMinutes) { clauses.push('window_minutes = ?'); args.push(Number(windowMinutes)); }
    if (since) { clauses.push('observed_at >= ?'); args.push(since); }
    const rows = this.db.prepare(`
      SELECT limit_id, limit_name, window_type, window_minutes, used_percent, resets_at, observed_at
      FROM server_usage_snapshots
      WHERE ${clauses.join(' AND ')}
      ORDER BY observed_at ASC
      LIMIT ?
    `).all(...args, limit);
    return {
      points: rows.map((row) => ({
        limitId: row.limit_id,
        limitName: row.limit_name,
        windowType: row.window_type,
        windowMinutes: Number(row.window_minutes) || null,
        usedPercent: Number(row.used_percent) || 0,
        resetsAt: row.resets_at == null ? null : Number(row.resets_at),
        observedAt: row.observed_at,
      })),
    };
  }

  // ---- M8 세션 흐름 계층 ------------------------------------------------
  // 턴 경계는 관측 사실이라 그대로 저장하고, 토큰 집계는 usage_events 에서
  // 뽑습니다. 되감기 때 같은 경계를 다시 쓰면 화면에 영향을 주는 필드가
  // 같으므로 changed 는 false — parser_version·updated_at 만 바뀌는 UPDATE 는
  // 스냅샷 브로드캐스트를 일으키지 않게 건너뜁니다(R2-a).
  upsertTurn({ provider, sessionId, turnIndex, startedAt = null, compacted = false, parserVersion = null }) {
    const providerId = normalizeProviderId(provider);
    if (!sessionId || !Number.isInteger(turnIndex)) throw new TypeError('turn requires sessionId and integer turnIndex');
    const existing = this.db.prepare(`
      SELECT started_at, compacted FROM turns
      WHERE provider = ? AND session_id = ? AND turn_index = ?
    `).get(providerId, sessionId, turnIndex);
    const nextCompacted = existing ? Math.max(existing.compacted, compacted ? 1 : 0) : (compacted ? 1 : 0);
    const nextStartedAt = existing?.started_at ?? startedAt ?? null;
    if (existing) {
      const sameStartedAt = nextStartedAt === (existing.started_at ?? null);
      const sameCompacted = nextCompacted === existing.compacted;
      if (sameStartedAt && sameCompacted) {
        return { changed: false, inserted: false, updated: false };
      }
    }
    this.db.prepare(`
      INSERT INTO turns (provider, session_id, turn_index, started_at, compacted, parser_version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, session_id, turn_index) DO UPDATE SET
        started_at = COALESCE(turns.started_at, excluded.started_at),
        compacted = MAX(turns.compacted, excluded.compacted),
        parser_version = excluded.parser_version,
        updated_at = excluded.updated_at
    `).run(providerId, sessionId, turnIndex, nextStartedAt, nextCompacted, parserVersion, isoNow());
    return existing
      ? { changed: true, inserted: false, updated: true }
      : { changed: true, inserted: true, updated: false };
  }

  // 파일을 처음부터 다시 읽을 때(절단/교체) 그 세션의 턴 경계를 지웁니다.
  // usage_events 는 중복 제거가 있어 다시 읽어도 안전하지만, 턴 번호는 스캔
  // 시작점에 따라 달라질 수 있어 재구성이 안전합니다.
  // 이 파일이 만든 요청 중 턴 번호가 아예 비어 있는 것이 있는지.
  //
  // 파서 버전만으로는 자기 치유가 안 되는 경우가 있습니다 — 버전을 올려
  // 재해석을 트리거했는데 그 버전 자체에 결함이 있어 메타를 못 쓴 채 버전
  // 도장만 찍히면, 이후엔 조건이 걸리지 않아 영구히 비어 있게 됩니다.
  // 그래서 버전과 함께 **원장 상태**도 봅니다. 재해석 뒤에는 모든 요청이
  // 정수 turn_index(경계 미확인은 0)를 갖게 되어 NULL 이 사라지므로
  // 조건이 다시 걸리지 않고, 루프가 생기지 않습니다.
  hasUnattributedTurns(provider, sourcePath) {
    const row = this.db.prepare(`
      SELECT 1 AS found FROM usage_events
      WHERE provider = ? AND source_path = ? AND turn_index IS NULL LIMIT 1
    `).get(normalizeProviderId(provider), sourcePath);
    return Boolean(row);
  }

  // 이어 읽기 시 턴 번호를 물려받기 위해 사용합니다. 없으면 0 —
  // 그러면 경계를 만나기 전까지의 요청은 0번(경계 미확인) 버킷에 남습니다.
  getLastTurnIndex(provider, sessionId) {
    if (!sessionId) return 0;
    const row = this.db.prepare(
      'SELECT MAX(turn_index) AS last_index FROM turns WHERE provider = ? AND session_id = ?',
    ).get(normalizeProviderId(provider), sessionId);
    return Number(row?.last_index) || 0;
  }

  resetTurns(provider, sessionId) {
    this.db.prepare('DELETE FROM turns WHERE provider = ? AND session_id = ?')
      .run(normalizeProviderId(provider), sessionId);
  }

  #mergeToolCounts(rows, column = 'tool_counts') {
    const merged = {};
    for (const row of rows) {
      if (!row[column]) continue;
      let parsed;
      try { parsed = JSON.parse(row[column]); } catch { continue; }
      for (const [name, count] of Object.entries(parsed ?? {})) {
        merged[name] = (merged[name] ?? 0) + (Number(count) || 0);
      }
    }
    return merged;
  }

  // 세션 순위. 파생 지표의 정의는 docs/dev/menus/session.md 에 못박아 두었습니다.
  getSessionRanking({ provider = null, since = null, until = null, limit = 30 } = {}) {
    const { where, args } = this.#usageFilter({ provider, since, until });
    const rows = this.db.prepare(`
      SELECT provider, session_id,
             COALESCE(NULLIF(project_name, ''), 'unknown-project') AS project_name,
             MAX(cwd) AS cwd, MAX(model) AS model,
             ${this.#tokenSums()},
             MAX(input_tokens + cache_write_input_tokens) AS peak_nested,
             MAX(input_tokens + cached_input_tokens + cache_write_input_tokens) AS peak_disjoint,
             MIN(COALESCE(event_timestamp, observed_at)) AS first_at,
             MAX(COALESCE(event_timestamp, observed_at)) AS last_at,
             COUNT(DISTINCT source_path) AS transcript_count,
             COUNT(DISTINCT CASE WHEN turn_index > 0 THEN turn_index END) AS turn_count,
             SUM(CASE WHEN COALESCE(turn_index, 0) = 0 THEN 1 ELSE 0 END) AS unassigned_requests
      FROM usage_events
      ${where}
      GROUP BY provider, session_id
      ORDER BY total_tokens DESC
      LIMIT ?
    `).all(...args, limit);

    const aliases = this.#aliasIndex();
    const toolStatement = this.db.prepare(
      'SELECT tool_counts FROM usage_events WHERE provider = ? AND session_id = ? AND tool_counts IS NOT NULL',
    );
    return rows.map((row) => {
      const tokens = this.#tokensFrom(row);
      // provider 마다 캐시가 input 안/밖이라 분모를 회계에 맞춰 만듭니다.
      const promptTokens = promptSideTokens(row.provider, tokens);
      const toolCounts = this.#mergeToolCounts(toolStatement.all(row.provider, row.session_id));
      const project = this.#applyProjectPrivacy({
        provider: row.provider,
        name: row.project_name,
        cwd: row.cwd,
      }, aliases);
      return {
        provider: row.provider,
        sessionId: row.session_id,
        projectKey: projectKeyOf(row.provider, row.project_name),
        projectName: project.name,
        cwd: project.cwd,
        redacted: project.redacted ?? false,
        model: row.model,
        tokens,
        promptTokens,
        // 재독 배수: 새로 만든 1토큰당 다시 읽은 토큰. 근거가 없으면 null 입니다.
        reuseMultiple: reuseMultiple(tokens),
        promptPerRequest: tokens.eventCount > 0 ? promptTokens / tokens.eventCount : 0,
        peakPromptTokens: Number(accountingOf(row.provider) === 'cache_disjoint' ? row.peak_disjoint : row.peak_nested) || 0,
        requestCount: tokens.eventCount,
        turnCount: Number(row.turn_count) || 0,
        unassignedRequests: Number(row.unassigned_requests) || 0,
        transcriptCount: Number(row.transcript_count) || 0,
        toolCounts,
        dominantPhase: dominantPhase(row.provider, toolCounts),
        firstAt: row.first_at,
        lastAt: row.last_at,
      };
    });
  }

  // 한 세션의 턴 원장 + 단계 배분 + 컨텍스트 곡선. 화면이 한 번에 필요한 것을
  // 함께 냅니다. 계산 근거는 전부 usage_events 이고 turns 는 경계만 줍니다.
  getSessionFlow({ provider, sessionId, curvePoints = 160 } = {}) {
    const providerId = normalizeProviderId(provider);
    if (!sessionId) return null;

    const summary = this.db.prepare(`
      SELECT COALESCE(NULLIF(project_name, ''), 'unknown-project') AS project_name,
             MAX(cwd) AS cwd, MAX(model) AS model,
             ${this.#tokenSums()},
             MAX(input_tokens + cache_write_input_tokens) AS peak_nested,
             MAX(input_tokens + cached_input_tokens + cache_write_input_tokens) AS peak_disjoint,
             MIN(COALESCE(event_timestamp, observed_at)) AS first_at,
             MAX(COALESCE(event_timestamp, observed_at)) AS last_at
      FROM usage_events WHERE provider = ? AND session_id = ?
    `).get(providerId, sessionId);
    if (!summary || !Number(summary.event_count)) return null;

    const turnRows = this.db.prepare(`
      SELECT COALESCE(e.turn_index, 0) AS turn_index,
             t.started_at AS boundary_at,
             COALESCE(t.compacted, 0) AS compacted,
             MIN(COALESCE(e.event_timestamp, e.observed_at)) AS first_at,
             MAX(COALESCE(e.event_timestamp, e.observed_at)) AS last_at,
             COUNT(*) AS request_count,
             COALESCE(SUM(e.input_tokens), 0) AS input_tokens,
             COALESCE(SUM(e.cached_input_tokens), 0) AS cached_input_tokens,
             COALESCE(SUM(e.cache_write_input_tokens), 0) AS cache_write_input_tokens,
             COALESCE(SUM(e.output_tokens), 0) AS output_tokens,
             COALESCE(SUM(e.reasoning_tokens), 0) AS reasoning_tokens
      FROM usage_events e
      LEFT JOIN turns t
        ON t.provider = e.provider AND t.session_id = e.session_id
       AND t.turn_index = COALESCE(e.turn_index, 0)
      WHERE e.provider = ? AND e.session_id = ?
      GROUP BY COALESCE(e.turn_index, 0), t.started_at, t.compacted
      ORDER BY COALESCE(e.turn_index, 0) ASC
    `).all(providerId, sessionId);

    const turnToolStatement = this.db.prepare(`
      SELECT tool_counts FROM usage_events
      WHERE provider = ? AND session_id = ? AND COALESCE(turn_index, 0) = ? AND tool_counts IS NOT NULL
    `);
    const phaseTotals = new Map();
    const turns = turnRows.map((row) => {
      const toolCounts = this.#mergeToolCounts(turnToolStatement.all(providerId, sessionId, row.turn_index));
      const turnPromptTokens = promptSideTokens(providerId, {
        inputTokens: Number(row.input_tokens),
        cachedInputTokens: Number(row.cached_input_tokens),
        cacheWriteInputTokens: Number(row.cache_write_input_tokens),
      });
      const turnTokens = turnPromptTokens + Number(row.output_tokens);
      for (const [phase, value] of splitTokensByPhase(providerId, toolCounts, turnTokens)) {
        phaseTotals.set(phase, (phaseTotals.get(phase) ?? 0) + value);
      }
      return {
        turnIndex: Number(row.turn_index),
        // 0번은 "경계 미확인" 버킷입니다 — 억지로 1번 턴에 붙이지 않습니다.
        boundary: Number(row.turn_index) > 0,
        startedAt: row.boundary_at ?? row.first_at,
        endedAt: row.last_at,
        compacted: Number(row.compacted) === 1,
        requestCount: Number(row.request_count) || 0,
        promptTokens: turnPromptTokens,
        outputTokens: Number(row.output_tokens) || 0,
        reasoningTokens: Number(row.reasoning_tokens) || 0,
        totalTokens: turnTokens,
        toolCounts,
        toolCalls: Object.values(toolCounts).reduce((sum, n) => sum + n, 0),
        phase: dominantPhase(providerId, toolCounts),
      };
    });

    const phaseSum = [...phaseTotals.values()].reduce((sum, value) => sum + value, 0);
    const phases = [...phaseTotals.entries()]
      .map(([phase, tokens]) => ({ phase, tokens: Math.round(tokens), share: phaseSum > 0 ? tokens / phaseSum : 0 }))
      .sort((left, right) => right.tokens - left.tokens);

    // 컨텍스트 곡선. 요청이 많으면 버킷으로 줄여 보냅니다 — 화면이 그릴 점의
    // 수는 유한하고, 응답을 부풀리지 않는 것이 원칙입니다.
    const raw = this.db.prepare(`
      SELECT COALESCE(event_timestamp, observed_at) AS at,
             input_tokens, cached_input_tokens, cache_write_input_tokens,
             output_tokens, COALESCE(turn_index, 0) AS turn_index
      FROM usage_events WHERE provider = ? AND session_id = ?
      ORDER BY at ASC, id ASC
    `).all(providerId, sessionId).map((row) => ({
      at: row.at,
      turn_index: row.turn_index,
      output_tokens: row.output_tokens,
      prompt_tokens: promptSideTokens(providerId, {
        inputTokens: Number(row.input_tokens),
        cachedInputTokens: Number(row.cached_input_tokens),
        cacheWriteInputTokens: Number(row.cache_write_input_tokens),
      }),
    }));
    const compactedTurns = new Set(turns.filter((turn) => turn.compacted).map((turn) => turn.turnIndex));
    // 컴팩션 표시는 그 턴의 **첫 요청**에만 붙입니다. 턴 안의 모든 요청에
    // 붙이면 곡선이 세로선 뭉치로 덮여 "어디서 꺾였나"가 오히려 안 보입니다.
    const compactionStarts = new Set();
    let previousTurn = null;
    for (let index = 0; index < raw.length; index += 1) {
      const turnIndex = Number(raw[index].turn_index);
      if (turnIndex !== previousTurn && compactedTurns.has(turnIndex)) compactionStarts.add(index);
      previousTurn = turnIndex;
    }

    const step = Math.max(1, Math.ceil(raw.length / curvePoints));
    const curve = [];
    for (let index = 0; index < raw.length; index += step) {
      const slice = raw.slice(index, index + step);
      curve.push({
        requestIndex: index + 1,
        at: slice[0].at,
        promptTokens: Math.round(slice.reduce((sum, r) => sum + Number(r.prompt_tokens), 0) / slice.length),
        peakPromptTokens: Math.max(...slice.map((r) => Number(r.prompt_tokens))),
        outputTokens: slice.reduce((sum, r) => sum + Number(r.output_tokens), 0),
        compacted: slice.some((_, offset) => compactionStarts.has(index + offset)),
      });
    }

    const sourcePaths = this.db.prepare(
      'SELECT DISTINCT source_path FROM usage_events WHERE provider = ? AND session_id = ?',
    ).all(providerId, sessionId).map((row) => row.source_path);
    // 메인 transcript = 파일 이름이 세션 id 인 것. 못 찾으면 첫 경로를 씁니다.
    const mainSourcePath = sourcePaths.find((candidate) => {
      const base = String(candidate).split(/[\\/]/).pop() ?? '';
      return base === `${sessionId}.jsonl` || base === sessionId;
    }) ?? sourcePaths[0] ?? null;

    const tokens = this.#tokensFrom(summary);
    const promptTokens = promptSideTokens(providerId, tokens);
    const project = this.#applyProjectPrivacy(
      { provider: providerId, name: summary.project_name, cwd: summary.cwd },
      this.#aliasIndex(),
    );
    return {
      session: {
        provider: providerId,
        sessionId,
        projectKey: projectKeyOf(providerId, summary.project_name),
        projectName: project.name,
        cwd: project.cwd,
        redacted: project.redacted ?? false,
        model: summary.model,
        tokens,
        promptTokens,
        reuseMultiple: reuseMultiple(tokens),
        peakPromptTokens: Number(accountingOf(providerId) === 'cache_disjoint' ? summary.peak_disjoint : summary.peak_nested) || 0,
        requestCount: tokens.eventCount,
        turnCount: turns.filter((turn) => turn.boundary).length,
        compactionCount: turns.filter((turn) => turn.compacted).length,
        firstAt: summary.first_at,
        lastAt: summary.last_at,
      },
      turns,
      phases,
      curve,
      // 가림된 프로젝트는 경로를 내보내지 않습니다(project.md 와 같은 규칙).
      source: { mainSourcePath: project.redacted ? null : mainSourcePath, transcriptCount: sourcePaths.length },
    };
  }

  // 원장을 파일 하나로 복사합니다. `VACUUM INTO` 를 쓰는 이유는 서비스가 살아
  // 있는 동안에도 **정합 스냅샷**을 주기 때문입니다 — 파일을 그대로 복사하면
  // WAL 이 활성인 순간에 찢어진 사본이 나옵니다.
  //
  // 백업에는 **가리지 않은 원본 경로가 들어갑니다.** 경로 가림은 조회 시점에
  // 적용되는 표시 규칙이고 저장은 원본이라, 백업 파일을 남에게 주는 것은
  // 프로젝트 경로를 주는 것과 같습니다. 화면이 그 사실을 적어야 합니다.
  backupTo(destPath) {
    this.db.exec(`VACUUM INTO '${String(destPath).replace(/'/g, "''")}'`);
    return destPath;
  }

  // 원장을 비웁니다. 별칭·가림은 **사람이 손으로 만든 것**이라 기본으로 남깁니다
  // — 측정값은 다시 스캔하면 되지만 별칭은 되살릴 방법이 없습니다.
  clearLedger({ keepAliases = true } = {}) {
    const before = this.getDiagnostics();
    this.transaction(() => {
      // 커서를 먼저 지웁니다. 중간에 실패해도 "원장은 비었는데 커서는 다
      // 읽었다고 말하는" 상태로 남지 않게 하려면 같은 트랜잭션이어야 합니다.
      for (const table of ['provider_scan_state', 'scan_state', 'usage_events', 'turns',
        'server_usage_snapshots', 'reconciliation_events', 'sessions']) {
        this.db.exec(`DELETE FROM ${table}`);
      }
      if (!keepAliases) this.db.exec('DELETE FROM project_aliases');
    });
    return { before, after: this.getDiagnostics() };
  }

  getDiagnostics() {
    const sessions = Number(this.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count) || 0;
    const usageEvents = Number(this.db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count) || 0;
    const rateSnapshots = Number(this.db.prepare('SELECT COUNT(*) AS count FROM server_usage_snapshots').get().count) || 0;
    const scanFiles = Number(this.db.prepare('SELECT COUNT(*) AS count FROM provider_scan_state').get().count) || 0;
    const parseResets = Number(this.db.prepare('SELECT COUNT(*) AS count FROM usage_events WHERE cumulative_reset = 1').get().count) || 0;
    return { dbPath: this.dbPath, sessions, usageEvents, rateSnapshots, scanFiles, cumulativeResets: parseResets };
  }
}
