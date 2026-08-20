import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isoNow, projectNameFromCwd } from './utils.mjs';

const USAGE_COLUMNS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'total_tokens',
];

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
        UNIQUE(provider, source_path, source_offset, window_type)
      );

      CREATE TABLE IF NOT EXISTS reconciliation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        window_type TEXT NOT NULL,
        from_observed_at TEXT NOT NULL,
        to_observed_at TEXT NOT NULL,
        server_usage_delta REAL,
        local_token_delta INTEGER NOT NULL DEFAULT 0,
        classification TEXT NOT NULL,
        confidence TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(provider, window_type, from_observed_at, to_observed_at)
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

      CREATE INDEX IF NOT EXISTS idx_usage_events_provider_time ON usage_events(provider, observed_at);
      CREATE INDEX IF NOT EXISTS idx_usage_events_project ON usage_events(provider, project_name, observed_at);
      CREATE INDEX IF NOT EXISTS idx_server_snapshots_provider_time ON server_usage_snapshots(provider, observed_at);
      CREATE INDEX IF NOT EXISTS idx_reconcile_provider_time ON reconciliation_events(provider, to_observed_at);
    `);
  }

  close() {
    this.db.close();
  }

  getScanState(sourcePath) {
    const row = this.db.prepare('SELECT * FROM scan_state WHERE source_path = ?').get(sourcePath);
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

  saveScanState({ sourcePath, byteOffset, fileSize, mtimeMs, previousUsage, sessionId }) {
    this.db.prepare(`
      INSERT INTO scan_state (
        source_path, byte_offset, file_size, mtime_ms,
        last_input_tokens, last_cached_input_tokens, last_cache_write_input_tokens,
        last_output_tokens, last_reasoning_tokens, last_total_tokens,
        last_session_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_path) DO UPDATE SET
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

  resetScanState(sourcePath) {
    this.db.prepare('DELETE FROM scan_state WHERE source_path = ?').run(sourcePath);
  }

  upsertSession(session, sourcePath, observedAt = isoNow()) {
    const sessionId = session.sessionId;
    if (!sessionId) return;
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
      'codex', sessionId, sourcePath,
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
    this.upsertSession(session, sourcePath, observedAt);
    const usage = event.delta;
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO usage_events (
        provider, session_id, source_path, source_offset, event_timestamp, observed_at,
        cwd, project_name, model,
        input_tokens, cached_input_tokens, cache_write_input_tokens,
        output_tokens, reasoning_tokens, total_tokens, cumulative_reset,
        measurement_source, measurement_quality
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local_log', 'observed')
    `).run(
      'codex', session.sessionId, sourcePath, sourceOffset,
      event.eventTimestamp ?? null, observedAt,
      session.cwd ?? null, session.projectName ?? projectNameFromCwd(session.cwd), session.model ?? null,
      usage.inputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens,
      usage.outputTokens, usage.reasoningTokens, usage.totalTokens,
      event.cumulativeReset ? 1 : 0,
    );
    return Number(result.changes) > 0;
  }

  insertRateLimits(event, sourcePath, sourceOffset, observedAt = isoNow()) {
    const inserted = [];
    const windows = [
      ['primary', event.rateLimits.primary],
      ['secondary', event.rateLimits.secondary],
    ];
    for (const [windowType, window] of windows) {
      if (!window) continue;
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO server_usage_snapshots (
          provider, session_id, source_path, source_offset, event_timestamp, observed_at,
          limit_id, limit_name, window_type, used_percent, window_minutes, resets_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'codex', event.session?.sessionId ?? null, sourcePath, sourceOffset,
        event.eventTimestamp ?? null, observedAt,
        event.rateLimits.limitId ?? null, event.rateLimits.limitName ?? null,
        windowType, window.usedPercent, window.windowMinutes, window.resetsAt,
      );
      if (Number(result.changes) > 0) {
        inserted.push(windowType);
        this.reconcileLatestWindow('codex', windowType);
      }
    }
    return inserted;
  }

  reconcileLatestWindow(provider, windowType) {
    const rows = this.db.prepare(`
      SELECT COALESCE(event_timestamp, observed_at) AS snapshot_at, used_percent, resets_at
      FROM server_usage_snapshots
      WHERE provider = ? AND window_type = ?
      ORDER BY COALESCE(event_timestamp, observed_at) DESC, id DESC LIMIT 2
    `).all(provider, windowType);
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
        provider, window_type, from_observed_at, to_observed_at,
        server_usage_delta, local_token_delta, classification, confidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      provider, windowType, previous.snapshot_at, current.snapshot_at,
      serverDelta, localTokenDelta, classification, confidence, isoNow(),
    );
    return { serverDelta, localTokenDelta, classification, confidence };
  }

  getLatestRateLimits(provider = 'codex') {
    const result = {};
    for (const windowType of ['primary', 'secondary']) {
      const row = this.db.prepare(`
        SELECT used_percent, window_minutes, resets_at,
               COALESCE(event_timestamp, observed_at) AS snapshot_at,
               limit_id, limit_name
        FROM server_usage_snapshots
        WHERE provider = ? AND window_type = ?
        ORDER BY COALESCE(event_timestamp, observed_at) DESC, id DESC LIMIT 1
      `).get(provider, windowType);
      if (row) {
        result[windowType] = {
          usedPercent: Number(row.used_percent),
          windowMinutes: row.window_minutes == null ? null : Number(row.window_minutes),
          resetsAt: row.resets_at == null ? null : Number(row.resets_at),
          observedAt: row.snapshot_at,
          limitId: row.limit_id,
          limitName: row.limit_name,
        };
      }
    }
    return result;
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

  getRecentReconciliation(provider = 'codex', limit = 12) {
    return this.db.prepare(`
      SELECT window_type, from_observed_at, to_observed_at, server_usage_delta,
             local_token_delta, classification, confidence
      FROM reconciliation_events
      WHERE provider = ?
      ORDER BY to_observed_at DESC LIMIT ?
    `).all(provider, limit).map((row) => ({
      windowType: row.window_type,
      from: row.from_observed_at,
      to: row.to_observed_at,
      serverUsageDelta: row.server_usage_delta == null ? null : Number(row.server_usage_delta),
      localTokenDelta: Number(row.local_token_delta) || 0,
      classification: row.classification,
      confidence: row.confidence,
    }));
  }

  getDiagnostics() {
    const sessions = Number(this.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count) || 0;
    const usageEvents = Number(this.db.prepare('SELECT COUNT(*) AS count FROM usage_events').get().count) || 0;
    const rateSnapshots = Number(this.db.prepare('SELECT COUNT(*) AS count FROM server_usage_snapshots').get().count) || 0;
    const scanFiles = Number(this.db.prepare('SELECT COUNT(*) AS count FROM scan_state').get().count) || 0;
    const parseResets = Number(this.db.prepare('SELECT COUNT(*) AS count FROM usage_events WHERE cumulative_reset = 1').get().count) || 0;
    return { dbPath: this.dbPath, sessions, usageEvents, rateSnapshots, scanFiles, cumulativeResets: parseResets };
  }
}
