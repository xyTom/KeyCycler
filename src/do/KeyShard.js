import { DurableObject } from "cloudflare:workers";

import { EVENT_TYPE, SHARD_COUNT, STATUS } from "../constants.js";
import { badRequest, json } from "../lib/http.js";
import { isValidHex2, shardUpperBound } from "../lib/shard.js";
import { clamp } from "../lib/rate_limit.js";

// ============================================================================
// Configuration Constants
// ============================================================================
const CURSOR_FLUSH_EVERY = 64; // Checkpoint cursor every N leases
const CURSOR_FLUSH_INTERVAL_MS = 1000; // Or flush if >1s since last flush
const COOL_BATCH_DELETE_SIZE = 64; // Batch delete expired cooldowns
const MAX_POOL_SIZE = 2000; // Memory ring hard limit (SQL can store more)

function safeLogShard(shard) {
  return isValidHex2(shard) ? shard : "??";
}

export class KeyShardV2 extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    // Memory state
    this.ringActive = []; // { seq, key_id, key_plain }[]
    this.ringUnknown = [];
    this.activeSet = new Set();
    this.unknownSet = new Set();

    // Persisted cooldowns (429)
    this.coolPersist = {}; // key_id -> { until_ms, streak, last_429_at }
    // Ephemeral min-interval cooldowns (not persisted)
    this.coolEphemeral = new Map(); // key_id -> until_ms
    // Pending expired cooldowns for batch deletion
    this.coolExpiredPending = [];

    // Cursor state (seq-based)
    this.cursorActiveSeq = 0;
    this.cursorUnknownSeq = 0;
    this.cursorDirtyCount = 0;
    this.cursorLastFlush = 0;

    this.shard = null;
    this.lower = null;
    this.upper = null;

    this.refillInFlight = null;

    this.cfg = this._loadConfig(env);

    // Initialize synchronously within blockConcurrencyWhile
    this.ctx.blockConcurrencyWhile(async () => {
      try {
        this._ensureSchema();
        this._loadFromSQL();
      } catch (e) {
        console.error(`[shard-${safeLogShard(this.shard)}] init failed:`, e?.message || e);
        this._resetInMemoryState();
      }

      try {
        await this._ensureAlarmScheduled();
      } catch (e) {
        console.error(`[shard-${safeLogShard(this.shard)}] init alarm failed:`, e?.message || e);
      }
    });
  }

  _resetInMemoryState() {
    this.ringActive = [];
    this.ringUnknown = [];
    this.activeSet = new Set();
    this.unknownSet = new Set();
    this.coolPersist = {};
    this.coolEphemeral = new Map();
    this.coolExpiredPending = [];
    this.cursorActiveSeq = 0;
    this.cursorUnknownSeq = 0;
    this.cursorDirtyCount = 0;
    this.cursorLastFlush = 0;
    this.refillInFlight = null;
  }

  _loadConfig(env) {
    const defaultRpm = parseInt(env.DEFAULT_RPM || "3", 10) || 3;
    const minIntervalMs = Math.ceil(60_000 / Math.max(defaultRpm, 1));

    const expectedGlobalRps = parseFloat(env.EXPECTED_GLOBAL_RPS || "2000") || 2000;
    const safety = parseFloat(env.SAFETY || "2.0") || 2.0;
    const expectedShardRps = expectedGlobalRps / SHARD_COUNT;
    const target = Math.ceil(expectedShardRps * (minIntervalMs / 1000) * safety);

    // With SQLite we can store more keys, but memory is still limited
    const maxPoolSizeRaw = parseInt(env.MAX_POOL_SIZE || "2000", 10) || 2000;
    const effectiveMaxPoolSize = Math.min(maxPoolSizeRaw, MAX_POOL_SIZE);
    const minPoolSizeRaw = parseInt(env.MIN_POOL_SIZE || "200", 10) || 200;
    const refillBatchRaw = parseInt(env.REFILL_BATCH || "200", 10) || 200;
    const initialFillRaw = parseInt(env.INITIAL_FILL || "200", 10) || 200;

    return {
      defaultRpm,
      minIntervalMs,
      maxScan: 200,

      maxPoolSize: effectiveMaxPoolSize,
      targetHotPoolSize: clamp(target, 200, effectiveMaxPoolSize),
      minPoolSize: clamp(minPoolSizeRaw, 1, effectiveMaxPoolSize),
      refillBatch: clamp(refillBatchRaw, 1, effectiveMaxPoolSize),
      initialFill: clamp(initialFillRaw, 1, effectiveMaxPoolSize),
      initialFillTimeoutMs: parseInt(env.INITIAL_FILL_TIMEOUT_MS || "3000", 10) || 3000,

      streakDecayMs: 5 * 60_000,
      unknownMaxStreak: 6,
      activeMaxStreak: 3,
      unknownCapMs: 30 * 60_000,
      activeCapMs: 10 * 60_000,
    };
  }

  // ============================================================================
  // Schema Management (PRAGMA user_version)
  // ============================================================================
  _ensureSchema() {
    const row = this.ctx.storage.sql.exec("PRAGMA user_version").one();
    const version = row?.user_version || 0;

    if (version < 1) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS ring (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            key_id TEXT UNIQUE NOT NULL,
            key_plain TEXT NOT NULL,
            pool TEXT NOT NULL CHECK(pool IN ('active', 'unknown'))
          )
        `);
        this.ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS cooldown (
            key_id TEXT PRIMARY KEY,
            until_ms INTEGER NOT NULL,
            streak INTEGER NOT NULL DEFAULT 0,
            last_429_at INTEGER NOT NULL
          )
        `);
        this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_cooldown_until ON cooldown(until_ms)");
        this.ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT
          )
        `);
        this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_ring_pool_seq ON ring(pool, seq)");
        this.ctx.storage.sql.exec("PRAGMA user_version = 1");
      });
    }

    // Future migrations: if (version < 2) { ... PRAGMA user_version = 2; }
  }

  // ============================================================================
  // SQL Loading
  // ============================================================================
  _loadFromSQL() {
    const now = Date.now();

    // Load rings with MAX_POOL_SIZE limit
    this.ringActive = this.ctx.storage.sql
      .exec("SELECT seq, key_id, key_plain FROM ring WHERE pool='active' ORDER BY seq LIMIT ?", this.cfg.maxPoolSize)
      .toArray();
    this.ringUnknown = this.ctx.storage.sql
      .exec("SELECT seq, key_id, key_plain FROM ring WHERE pool='unknown' ORDER BY seq LIMIT ?", this.cfg.maxPoolSize)
      .toArray();

    // Load unexpired cooldowns
    const coolRows = this.ctx.storage.sql
      .exec("SELECT key_id, until_ms, streak, last_429_at FROM cooldown WHERE until_ms > ?", now)
      .toArray();
    this.coolPersist = {};
    for (const row of coolRows) {
      this.coolPersist[row.key_id] = {
        until_ms: row.until_ms,
        streak: row.streak,
        last_429_at: row.last_429_at,
      };
    }

    // Load cursors
    this.cursorActiveSeq = this._getMetaInt("cursor_active_seq") ?? 0;
    this.cursorUnknownSeq = this._getMetaInt("cursor_unknown_seq") ?? 0;

    // Load shard
    const shard = this._getMeta("shard");
    if (isValidHex2(shard)) this._setShard(shard);

    this._rebuildSets();
    this._validateCursors();

    // Reset flush tracking
    this.cursorDirtyCount = 0;
    this.cursorLastFlush = now;
  }

  // ============================================================================
  // Cursor Validation
  // ============================================================================
  _validateCursors() {
    // If cursorActiveSeq doesn't exist in ring, reset to min seq - 1
    if (this.ringActive.length > 0) {
      const seqs = this.ringActive.map((r) => r.seq);
      if (!seqs.includes(this.cursorActiveSeq)) {
        this.cursorActiveSeq = Math.min(...seqs) - 1;
      }
    } else {
      this.cursorActiveSeq = 0;
    }

    // Same for unknown ring
    if (this.ringUnknown.length > 0) {
      const seqs = this.ringUnknown.map((r) => r.seq);
      if (!seqs.includes(this.cursorUnknownSeq)) {
        this.cursorUnknownSeq = Math.min(...seqs) - 1;
      }
    } else {
      this.cursorUnknownSeq = 0;
    }
  }

  // ============================================================================
  // Meta Helpers
  // ============================================================================
  _getMeta(key) {
    const row = this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).one();
    return row?.value ?? null;
  }

  _getMetaInt(key) {
    const v = this._getMeta(key);
    if (v == null) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }

  _setMeta(key, value) {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, String(value));
  }

  // ============================================================================
  // Set Helpers
  // ============================================================================
  _rebuildSets() {
    this.activeSet = new Set(this.ringActive.map((r) => r.key_id));
    this.unknownSet = new Set(this.ringUnknown.map((r) => r.key_id));
  }

  _setShard(shard) {
    this.shard = shard;
    this.lower = shard;
    this.upper = shardUpperBound(shard);
  }

  // ============================================================================
  // Cursor Checkpoint
  // ============================================================================
  _maybePersistCursor(nowMs) {
    this.cursorDirtyCount++;

    if (
      this.cursorDirtyCount >= CURSOR_FLUSH_EVERY ||
      nowMs - this.cursorLastFlush >= CURSOR_FLUSH_INTERVAL_MS
    ) {
      this._flushCursors();
      this.cursorDirtyCount = 0;
      this.cursorLastFlush = nowMs;
    }
  }

  _flushCursors() {
    this.ctx.storage.transactionSync(() => {
      this._setMeta("cursor_active_seq", this.cursorActiveSeq);
      this._setMeta("cursor_unknown_seq", this.cursorUnknownSeq);
    });
  }

  // ============================================================================
  // Cooldown Helpers
  // ============================================================================
  _setEphemeralCooldown(keyId, untilMs) {
    const prev = this.coolEphemeral.get(keyId) || 0;
    if (untilMs > prev) this.coolEphemeral.set(keyId, untilMs);
  }

  _isCooling(keyId, nowMs) {
    // Check ephemeral (min-interval) first
    const eph = this.coolEphemeral.get(keyId);
    if (eph && eph > nowMs) return true;
    if (eph && eph <= nowMs) this.coolEphemeral.delete(keyId);

    // Check persisted (429)
    const persisted = this.coolPersist[keyId];
    if (!persisted) return false;

    if (persisted.until_ms > nowMs) return true;

    // Expired - add to pending batch delete
    delete this.coolPersist[keyId];
    this.coolExpiredPending.push(keyId);

    // Batch delete when threshold reached
    if (this.coolExpiredPending.length >= COOL_BATCH_DELETE_SIZE) {
      this._flushExpiredCooldowns();
    }

    return false;
  }

  _flushExpiredCooldowns() {
    if (this.coolExpiredPending.length === 0) return;

    const ids = this.coolExpiredPending.splice(0);
    this.ctx.storage.transactionSync(() => {
      for (const keyId of ids) {
        this.ctx.storage.sql.exec("DELETE FROM cooldown WHERE key_id = ?", keyId);
      }
    });
  }

  // ============================================================================
  // Lease Logic (Memory + Cursor Checkpoint)
  // ============================================================================
  _pickFromRing(ring, pool, nowMs) {
    if (ring.length === 0) return null;

    const cursorSeq = pool === "active" ? this.cursorActiveSeq : this.cursorUnknownSeq;

    // Find from after cursor
    for (const entry of ring) {
      if (entry.seq <= cursorSeq) continue;
      if (this._isCooling(entry.key_id, nowMs)) continue;

      // Found - update memory cursor
      if (pool === "active") this.cursorActiveSeq = entry.seq;
      else this.cursorUnknownSeq = entry.seq;

      // Checkpoint cursor (not every time)
      this._maybePersistCursor(nowMs);

      // Set min-interval cooldown (memory only)
      this._setEphemeralCooldown(entry.key_id, nowMs + this.cfg.minIntervalMs);

      return entry;
    }

    // Wrap around: search from beginning
    for (const entry of ring) {
      if (this._isCooling(entry.key_id, nowMs)) continue;

      if (pool === "active") this.cursorActiveSeq = entry.seq;
      else this.cursorUnknownSeq = entry.seq;

      this._maybePersistCursor(nowMs);
      this._setEphemeralCooldown(entry.key_id, nowMs + this.cfg.minIntervalMs);
      return entry;
    }

    return null; // All cooling
  }

  // ============================================================================
  // Cooldown Handling (429)
  // ============================================================================
  _handleRateLimit(keyId, pool, ttlMs, nowMs) {
    // Calculate streak
    const existing = this.coolPersist[keyId] || { streak: 0, last_429_at: 0 };
    let streak = existing.streak;
    if (nowMs - existing.last_429_at > this.cfg.streakDecayMs) streak = 0;

    const isUnknown = pool === "unknown";
    const maxStreak = isUnknown ? this.cfg.unknownMaxStreak : this.cfg.activeMaxStreak;
    const capMs = isUnknown ? this.cfg.unknownCapMs : this.cfg.activeCapMs;
    streak = Math.min(streak, maxStreak);

    ttlMs = ttlMs * Math.pow(2, streak);
    ttlMs = Math.min(ttlMs, capMs);
    ttlMs += Math.floor(ttlMs * 0.1 * Math.random()); // jitter

    const entry = {
      until_ms: nowMs + ttlMs,
      streak: Math.min(streak + 1, maxStreak),
      last_429_at: nowMs,
    };

    // Update memory
    this.coolPersist[keyId] = entry;

    // Sync write to SQL
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO cooldown (key_id, until_ms, streak, last_429_at) VALUES (?, ?, ?, ?)",
      keyId,
      entry.until_ms,
      entry.streak,
      entry.last_429_at,
    );
  }

  // ============================================================================
  // Refill from D1
  // ============================================================================
  async _initialFillTimeboxed() {
    if (!this.refillInFlight) {
      const doFill = async () => {
        await this._refillToAtLeast(this.cfg.initialFill);
      };

      this.refillInFlight = doFill().finally(() => {
        this.refillInFlight = null;
      });
    }

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("initial_fill_timeout")), this.cfg.initialFillTimeoutMs),
    );
    return Promise.race([this.refillInFlight, timeout]);
  }

  async _refillToAtLeast(minTotal) {
    const total = this.ringActive.length + this.ringUnknown.length;
    if (total >= minTotal) return;

    const need = minTotal - total;
    let added = 0;
    added += await this._refillStatus(STATUS.ACTIVE, need);
    if (added < need) added += await this._refillStatus(STATUS.UNKNOWN, need - added);
  }

  async _refillStatus(status, want) {
    if (!this.shard) return 0;
    if (want <= 0) return 0;

    const lower = this.lower;
    const upper = this.upper;

    const cursorMetaKey = status === STATUS.ACTIVE ? "refill_cursor_active" : "refill_cursor_unknown";
    let cursorKey = this._getMeta(cursorMetaKey) || lower;

    const limitBase = this.cfg.refillBatch * 2;
    const sql =
      "SELECT key_id, key_plain FROM keys WHERE status=? AND key_id >= ? AND key_id < ? AND key_id > ? ORDER BY key_id LIMIT ?";

    let added = 0;
    let wrapped = false;
    let poolFull = false;
    let poolSize = status === STATUS.ACTIVE ? this.ringActive.length : this.ringUnknown.length;
    const targetPool = status === STATUS.ACTIVE ? "active" : "unknown";

    while (added < want) {
      if (poolSize >= this.cfg.maxPoolSize) break;

      const limit = Math.min(limitBase, (want - added) * 2);
      const res = await this.env.KEY_DB.prepare(sql).bind(status, lower, upper, cursorKey, limit).all();
      const rows = res.results || [];

      if (rows.length === 0) {
        if (wrapped) break;
        cursorKey = lower;
        wrapped = true;
        continue;
      }

      cursorKey = rows[rows.length - 1].key_id;

      // SQL write phase uses transactionSync
      this.ctx.storage.transactionSync(() => {
        for (const row of rows) {
          if (added >= want) break;
          if (poolSize >= this.cfg.maxPoolSize) {
            poolFull = true;
            break;
          }
          if (this.activeSet.has(row.key_id) || this.unknownSet.has(row.key_id)) continue;

          this.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO ring (key_id, key_plain, pool) VALUES (?, ?, ?)",
            row.key_id,
            row.key_plain,
            targetPool,
          );
          const changed = this.ctx.storage.sql.exec("SELECT changes() AS n").one()?.n || 0;
          if (changed > 0) {
            added++;
            poolSize++;
            if (targetPool === "active") this.activeSet.add(row.key_id);
            else this.unknownSet.add(row.key_id);
          }
        }

        this._setMeta(cursorMetaKey, cursorKey);
      });
      if (poolFull) break;
    }

    if (added > 0) this._reloadRingsFromSQL();
    return added;
  }

  _reloadRingsFromSQL() {
    this.ringActive = this.ctx.storage.sql
      .exec("SELECT seq, key_id, key_plain FROM ring WHERE pool='active' ORDER BY seq LIMIT ?", this.cfg.maxPoolSize)
      .toArray();
    this.ringUnknown = this.ctx.storage.sql
      .exec("SELECT seq, key_id, key_plain FROM ring WHERE pool='unknown' ORDER BY seq LIMIT ?", this.cfg.maxPoolSize)
      .toArray();
    this._rebuildSets();
    this._validateCursors();
  }

  // ============================================================================
  // Key Management
  // ============================================================================
  _promoteKey(keyId) {
    this.ctx.storage.sql.exec("UPDATE ring SET pool = 'active' WHERE key_id = ?", keyId);
    this._reloadRingsFromSQL();
  }

  _removeKeyEverywhere(keyId) {
    const wasInActive = this.activeSet.has(keyId);
    const wasInUnknown = this.unknownSet.has(keyId);

    // Always delete from SQL, even if this key is not currently in memory.
    let sqlRingDeleted = 0;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM ring WHERE key_id = ?", keyId);
      sqlRingDeleted = this.ctx.storage.sql.exec("SELECT changes() AS n").one()?.n || 0;
      this.ctx.storage.sql.exec("DELETE FROM cooldown WHERE key_id = ?", keyId);
    });

    // Update memory only when this key is currently loaded.
    if (wasInActive) {
      this.ringActive = this.ringActive.filter((r) => r.key_id !== keyId);
    }
    if (wasInUnknown) {
      this.ringUnknown = this.ringUnknown.filter((r) => r.key_id !== keyId);
    }
    delete this.coolPersist[keyId];
    this.coolEphemeral.delete(keyId);

    if (wasInActive || wasInUnknown) {
      this._rebuildSets();
      this._validateCursors();
    }

    const found = wasInActive || wasInUnknown || sqlRingDeleted > 0;
    return { found };
  }

  // ============================================================================
  // Alarm
  // ============================================================================
  async _ensureAlarmScheduled() {
    const current = await this.ctx.storage.getAlarm();
    if (current != null) return;
    const jitter = Math.floor(Math.random() * 60_000);
    await this.ctx.storage.setAlarm(Date.now() + 300_000 + jitter);
  }

  async _scheduleAlarmSoon() {
    const current = await this.ctx.storage.getAlarm();
    const jitter = Math.floor(Math.random() * 30_000);
    const target = Date.now() + 1_000 + jitter;
    if (current == null || target < current) await this.ctx.storage.setAlarm(target);
  }

  async alarm() {
    const now = Date.now();

    // Cleanup expired cooldowns in SQL
    this.ctx.storage.sql.exec("DELETE FROM cooldown WHERE until_ms <= ?", now);

    // Also clean memory coolPersist
    for (const [keyId, v] of Object.entries(this.coolPersist)) {
      if (!v || typeof v.until_ms !== "number" || v.until_ms <= now) {
        delete this.coolPersist[keyId];
      }
    }

    // Flush any pending cursor
    if (this.cursorDirtyCount > 0) {
      this._flushCursors();
      this.cursorDirtyCount = 0;
      this.cursorLastFlush = now;
    }

    // Flush any pending expired cooldowns
    this._flushExpiredCooldowns();

    // Refill if needed
    const total = this.ringActive.length + this.ringUnknown.length;
    const target = Math.max(this.cfg.minPoolSize, this.cfg.targetHotPoolSize);
    if (total < target) {
      try {
        await this._refillToAtLeast(target);
      } catch (e) {
        console.error(`[shard-${safeLogShard(this.shard)}] refill failed:`, e?.message || e);
      }
    }

    // Reschedule next alarm
    const jitter = Math.floor(Math.random() * 60_000);
    try {
      await this.ctx.storage.setAlarm(Date.now() + 300_000 + jitter);
    } catch (e) {
      console.error(`[shard-${safeLogShard(this.shard)}] setAlarm failed:`, e?.message || e);
    }
  }

  // ============================================================================
  // Shard Initialization
  // ============================================================================
  async _ensureShardFromRequest(req) {
    const shard = (req.headers.get("x-shard") || "").toLowerCase();
    if (!isValidHex2(shard)) throw new Error("missing_or_invalid_x-shard");

    if (this.shard && this.shard !== shard) throw new Error("shard_mismatch");
    if (!this.shard) {
      this._setShard(shard);
      this._setMeta("shard", shard);
    }
    return shard;
  }

  // ============================================================================
  // HTTP Handler
  // ============================================================================
  async fetch(req) {
    await this._ensureShardFromRequest(req);

    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/lease") {
      const now = Date.now();

      const fromActive = this._pickFromRing(this.ringActive, "active", now);
      if (fromActive) return json({ key_id: fromActive.key_id, key_plain: fromActive.key_plain, pool: "active" });

      const fromUnknown = this._pickFromRing(this.ringUnknown, "unknown", now);
      if (fromUnknown)
        return json({ key_id: fromUnknown.key_id, key_plain: fromUnknown.key_plain, pool: "unknown" });

      // Cold start: attempt fill
      if (this.ringActive.length + this.ringUnknown.length === 0) {
        try {
          await this._initialFillTimeboxed();
        } catch {
          await this._scheduleAlarmSoon();
          return json({ reason: "warming" }, { status: 503 });
        }

        const a2 = this._pickFromRing(this.ringActive, "active", now);
        if (a2) return json({ key_id: a2.key_id, key_plain: a2.key_plain, pool: "active" });
        const u2 = this._pickFromRing(this.ringUnknown, "unknown", now);
        if (u2) return json({ key_id: u2.key_id, key_plain: u2.key_plain, pool: "unknown" });
      }

      await this._scheduleAlarmSoon();
      return json({ reason: "pool_empty" }, { status: 503 });
    }

    if (req.method === "POST" && url.pathname === "/report") {
      const payload = await req.json().catch(() => null);
      if (!payload || typeof payload !== "object") return badRequest("Invalid JSON");

      const keyId = payload.key_id;
      const pool = payload.pool;
      const outcome = payload.outcome;
      const now = Date.now();

      if (typeof keyId !== "string" || keyId.length < 8) return badRequest("Missing key_id");

      if (outcome === "RATE_LIMIT") {
        let ttlMs = typeof payload.ttl_ms === "number" ? payload.ttl_ms : 60_000;
        ttlMs = clamp(ttlMs, 1_000, 86_400_000);
        this._handleRateLimit(keyId, pool, ttlMs, now);
        return json({ ok: true });
      }

      if (outcome === "INVALID" || outcome === "QUOTA") {
        const removed = this._removeKeyEverywhere(keyId);

        const type = outcome === "INVALID" ? EVENT_TYPE.MARK_INVALID : EVENT_TYPE.MARK_QUOTA;
        const lastError = payload.error_code || "unknown";
        try {
          await this.env.KEY_EVENTS.send({ type, key_id: keyId, last_error: lastError });
        } catch {
          // Best-effort
        }

        if (this.ringActive.length + this.ringUnknown.length < this.cfg.minPoolSize) {
          await this._scheduleAlarmSoon();
        }

        return json({ ok: true, removed: removed.found });
      }

      if (outcome === "PROMOTE_OK") {
        if (this.unknownSet.has(keyId)) {
          this._promoteKey(keyId);
          try {
            await this.env.KEY_EVENTS.send({ type: EVENT_TYPE.PROMOTE_ACTIVE, key_id: keyId });
          } catch {
            // Best-effort
          }
        }
        return json({ ok: true });
      }

      if (outcome === "ERROR") {
        let ttlMs =
          typeof payload.ttl_ms === "number"
            ? payload.ttl_ms
            : 30_000 + Math.floor(Math.random() * 90_000);
        ttlMs = clamp(ttlMs, 1_000, 300_000);
        const until = now + ttlMs;
        this._setEphemeralCooldown(keyId, until);
        return json({ ok: true });
      }

      return badRequest("Unknown outcome");
    }

    if (req.method === "POST" && url.pathname === "/admin/remove") {
      const payload = await req.json().catch(() => null);
      const ids = Array.isArray(payload?.key_ids) ? payload.key_ids : [];
      if (ids.length === 0) return badRequest("Provide key_ids");

      let removed = 0;
      for (const id of ids) {
        const r = this._removeKeyEverywhere(String(id).toLowerCase());
        if (r.found) removed += 1;
      }
      return json({ ok: true, removed });
    }

    return json({ error: { message: "Not found" } }, { status: 404 });
  }
}
