import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isoNow, projectKeyOf, projectNameFromCwd } from './utils.mjs';

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
        cumulative_reset INTEGER NOT NULL DEFAULT 0,
        measurement_source TEXT NOT NULL DEFAULT 'local_log',
        measurement_quality TEXT NOT NULL DEFAULT 'observed',
        event_key TEXT,
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
    `);

    this.#upgradeSchema();
  }

  #tableColumns(table) {
    return new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  }

  #upgradeSchema() {
    const usageColumns = this.#tableColumns('usage_events');
    if (!usageColumns.has('event_key')) this.db.exec('ALTER TABLE usage_events ADD COLUMN event_key TEXT');

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
    };
  }

  saveScanState({ provider, sourcePath, byteOffset, fileSize, mtimeMs, previousUsage, sessionId }) {
    const providerId = normalizeProviderId(provider);
    this.db.prepare(`
      INSERT INTO provider_scan_state (
        provider, source_path, byte_offset, file_size, mtime_ms,
        last_input_tokens, last_cached_input_tokens, last_cache_write_input_tokens,
        last_output_tokens, last_reasoning_tokens, last_total_tokens,
        last_session_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        updated_at=excluded.updated_at
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

  insertUsageEvent(event, sourcePath, sourceOffset, observedAt = isoNow()) {
    const session = event.session;
    const provider = normalizeProviderId(event.provider ?? session?.provider);
    this.upsertSession(session, sourcePath, observedAt);
    const usage = event.delta;
    const eventKey = event.eventKey ?? stableEventKey(
      provider, session.sessionId, event.eventTimestamp, session.model, usage,
    );
    if (eventKey) {
      const duplicate = this.db.prepare(`
        SELECT 1 FROM usage_events
        WHERE provider = ? AND (
          event_key = ? OR (
            session_id = ? AND event_timestamp = ? AND COALESCE(model, '') = COALESCE(?, '')
            AND input_tokens = ? AND cached_input_tokens = ? AND cache_write_input_tokens = ?
            AND output_tokens = ? AND reasoning_tokens = ? AND total_tokens = ?
          )
        ) LIMIT 1
      `).get(
        provider, eventKey, session.sessionId, event.eventTimestamp, session.model ?? null,
        usage.inputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens,
        usage.outputTokens, usage.reasoningTokens, usage.totalTokens,
      );
      if (duplicate) return false;
    }
    const measurementSource = event.measurementSource ?? 'local_log';
    const measurementQuality = event.measurementQuality ?? 'local_exact';
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO usage_events (
        provider, session_id, source_path, source_offset, event_timestamp, observed_at,
        cwd, project_name, model,
        input_tokens, cached_input_tokens, cache_write_input_tokens,
        output_tokens, reasoning_tokens, total_tokens, cumulative_reset,
        measurement_source, measurement_quality, event_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      provider, session.sessionId, sourcePath, sourceOffset,
      event.eventTimestamp ?? null, observedAt,
      session.cwd ?? null, session.projectName ?? projectNameFromCwd(session.cwd), session.model ?? null,
      usage.inputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens,
      usage.outputTokens, usage.reasoningTokens, usage.totalTokens,
      event.cumulativeReset ? 1 : 0,
      measurementSource, measurementQuality, eventKey,
    );
    return Number(result.changes) > 0;
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
      if (snapshotKey) {
        const duplicate = this.db.prepare(`
          SELECT 1 FROM server_usage_snapshots
          WHERE provider = ? AND (
            snapshot_key = ? OR (
              COALESCE(session_id, '') = COALESCE(?, '') AND event_timestamp = ?
              AND COALESCE(limit_id, 'default') = ? AND window_type = ?
              AND used_percent = ? AND COALESCE(window_minutes, -1) = COALESCE(?, -1)
              AND COALESCE(resets_at, -1) = COALESCE(?, -1)
            )
          ) LIMIT 1
        `).get(
          provider, snapshotKey, event.session?.sessionId ?? null, event.eventTimestamp,
          limitId, windowType, window.usedPercent, window.windowMinutes, window.resetsAt,
        );
        if (duplicate) continue;
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
      ORDER BY total_tokens DESC
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
      ORDER BY total_tokens DESC
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

  getDiagnostics() {
    const sessions = Number(this.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count) || 0;
    const usageEvents = Number(this.db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count) || 0;
    const rateSnapshots = Number(this.db.prepare('SELECT COUNT(*) AS count FROM server_usage_snapshots').get().count) || 0;
    const scanFiles = Number(this.db.prepare('SELECT COUNT(*) AS count FROM provider_scan_state').get().count) || 0;
    const parseResets = Number(this.db.prepare('SELECT COUNT(*) AS count FROM usage_events WHERE cumulative_reset = 1').get().count) || 0;
    return { dbPath: this.dbPath, sessions, usageEvents, rateSnapshots, scanFiles, cumulativeResets: parseResets };
  }
}
