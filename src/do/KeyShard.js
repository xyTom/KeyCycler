import { DurableObject } from "cloudflare:workers";

import { EVENT_TYPE, SHARD_COUNT, STATUS } from "../constants.js";
import { badRequest, json } from "../lib/http.js";
import { isValidHex2, shardUpperBound } from "../lib/shard.js";
import { clamp } from "../lib/rate_limit.js";

function safeLogShard(shard) {
  return isValidHex2(shard) ? shard : "??";
}

export class KeyShard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    this.shard = null; // 2 hex chars
    this.lower = null;
    this.upper = null;

    this.ringActive = [];
    this.ringUnknown = [];
    this.activeSet = new Set();
    this.unknownSet = new Set();

    // Persisted cooldowns only (429).
    this.coolPersist = {}; // key_id -> { until_ms, streak, last_429_at }
    this.coolDirty = false;

    // Ephemeral min-interval + transient ERROR cooldowns only (not persisted).
    this.coolEphemeral = new Map(); // key_id -> until_ms

    this.cursorActiveKeyid = null;
    this.cursorUnknownKeyid = null;
    this.cursorIdxActive = 0;
    this.cursorIdxUnknown = 0;

    this.refillInFlight = null;

    this.cfg = this._loadConfig(env);

    // If storage contains unexpected/corrupted values, we should still serve and self-heal
    // rather than permanently blocking this DO instance.
    this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this._loadFromStorage();
      } catch (e) {
        console.error(`[shard-${safeLogShard(this.shard)}] init load failed:`, e?.message || e);
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
    this.coolDirty = false;
    this.coolEphemeral = new Map();
    this.cursorActiveKeyid = null;
    this.cursorUnknownKeyid = null;
    this.cursorIdxActive = 0;
    this.cursorIdxUnknown = 0;
    this.refillInFlight = null;
  }

  _loadConfig(env) {
    const defaultRpm = parseInt(env.DEFAULT_RPM || "3", 10) || 3;
    const minIntervalMs = Math.ceil(60_000 / Math.max(defaultRpm, 1));

    const expectedGlobalRps = parseFloat(env.EXPECTED_GLOBAL_RPS || "2000") || 2000;
    const safety = parseFloat(env.SAFETY || "2.0") || 2.0;
    const expectedShardRps = expectedGlobalRps / SHARD_COUNT;
    const target = Math.ceil(expectedShardRps * (minIntervalMs / 1000) * safety);

    const maxPoolSize = parseInt(env.MAX_POOL_SIZE || "700", 10) || 700;
    const minPoolSizeRaw = parseInt(env.MIN_POOL_SIZE || "200", 10) || 200;
    const refillBatchRaw = parseInt(env.REFILL_BATCH || "200", 10) || 200;
    const initialFillRaw = parseInt(env.INITIAL_FILL || "200", 10) || 200;

    return {
      defaultRpm,
      minIntervalMs,
      maxScan: 200,

      // Pool sizing: computed target, then clamped.
      // DO storage limit: 128KB per value. Each entry ~130 bytes, max ~900 keys per ring.
      maxPoolSize,
      targetHotPoolSize: clamp(target, 200, maxPoolSize),
      minPoolSize: clamp(minPoolSizeRaw, 1, maxPoolSize),
      refillBatch: clamp(refillBatchRaw, 1, maxPoolSize),
      initialFill: clamp(initialFillRaw, 1, maxPoolSize),
      initialFillTimeoutMs: parseInt(env.INITIAL_FILL_TIMEOUT_MS || "3000", 10) || 3000,

      streakDecayMs: 5 * 60_000,
      unknownMaxStreak: 6,
      activeMaxStreak: 3,
      unknownCapMs: 30 * 60_000,
      activeCapMs: 10 * 60_000,
    };
  }

  async _safeGet(key, fallback) {
    try {
      const v = await this.ctx.storage.get(key);
      return v == null ? fallback : v;
    } catch (e) {
      console.error(`[shard-${safeLogShard(this.shard)}] storage.get(${key}) failed:`, e?.message || e);
      return fallback;
    }
  }

  async _loadFromStorage() {
    const shard = await this._safeGet("shard", null);
    if (isValidHex2(shard)) this._setShard(shard);

    const ringActive = await this._safeGet("ring_active", []);
    const ringUnknown = await this._safeGet("ring_unknown", []);

    this.ringActive = Array.isArray(ringActive)
      ? ringActive.filter((e) => e && typeof e.key_id === "string" && typeof e.key_plain === "string")
      : [];
    this.ringUnknown = Array.isArray(ringUnknown)
      ? ringUnknown.filter((e) => e && typeof e.key_id === "string" && typeof e.key_plain === "string")
      : [];

    this.cursorActiveKeyid = (await this._safeGet("cursor_active_keyid", null)) || null;
    this.cursorUnknownKeyid = (await this._safeGet("cursor_unknown_keyid", null)) || null;

    const idxA = await this._safeGet("cursor_idx_active", 0);
    const idxU = await this._safeGet("cursor_idx_unknown", 0);
    this.cursorIdxActive = Number.isFinite(idxA) ? idxA : 0;
    this.cursorIdxUnknown = Number.isFinite(idxU) ? idxU : 0;

    const cool = await this._safeGet("cool_map", {});
    this.coolPersist = cool && typeof cool === "object" && !Array.isArray(cool) ? cool : {};

    this._rebuildSets();

    // Clamp indices to current ring sizes.
    if (this.ringActive.length > 0) this.cursorIdxActive %= this.ringActive.length;
    if (this.ringUnknown.length > 0) this.cursorIdxUnknown %= this.ringUnknown.length;
  }

  _rebuildSets() {
    this.activeSet = new Set(this.ringActive.map((k) => k?.key_id).filter(Boolean));
    this.unknownSet = new Set(this.ringUnknown.map((k) => k?.key_id).filter(Boolean));
  }

  _setShard(shard) {
    this.shard = shard;
    this.lower = shard;
    this.upper = shardUpperBound(shard);
  }

  async _ensureShardFromRequest(req) {
    const shard = (req.headers.get("x-shard") || "").toLowerCase();
    if (!isValidHex2(shard)) throw new Error("missing_or_invalid_x-shard");

    if (this.shard && this.shard !== shard) throw new Error("shard_mismatch");
    if (!this.shard) {
      this._setShard(shard);
      await this.ctx.storage.put("shard", shard);
    }
    return shard;
  }

  async _ensureAlarmScheduled() {
    const current = await this.ctx.storage.getAlarm();
    if (current != null) return;
    const jitter = Math.floor(Math.random() * 30_000);
    await this.ctx.storage.setAlarm(Date.now() + 60_000 + jitter);
  }

  async _scheduleAlarmSoon() {
    const current = await this.ctx.storage.getAlarm();
    const jitter = Math.floor(Math.random() * 30_000);
    const target = Date.now() + 1_000 + jitter;
    if (current == null || target < current) await this.ctx.storage.setAlarm(target);
  }

  _coolUntilMs(keyId, nowMs) {
    const persisted = this.coolPersist[keyId]?.until_ms || 0;
    const eph = this.coolEphemeral.get(keyId) || 0;
    const until = Math.max(persisted, eph);
    if (until <= nowMs) {
      if (eph && eph <= nowMs) this.coolEphemeral.delete(keyId);
      if (persisted && persisted <= nowMs) {
        delete this.coolPersist[keyId];
        this.coolDirty = true;
      }
      return 0;
    }
    return until;
  }

  _pickFromRing(ring, pool, nowMs) {
    if (ring.length === 0) return null;

    let idxRef = pool === "active" ? this.cursorIdxActive : this.cursorIdxUnknown;
    const maxScan = Math.min(this.cfg.maxScan, ring.length);

    for (let i = 0; i < maxScan; i++) {
      const idx = (idxRef + i) % ring.length;
      const entry = ring[idx];
      const until = this._coolUntilMs(entry.key_id, nowMs);
      if (until > nowMs) continue;

      // Advance cursor for next request.
      const nextIdx = (idx + 1) % ring.length;
      if (pool === "active") this.cursorIdxActive = nextIdx;
      else this.cursorIdxUnknown = nextIdx;

      // Min-interval guard (ephemeral only).
      const minUntil = nowMs + this.cfg.minIntervalMs;
      const prev = this.coolEphemeral.get(entry.key_id) || 0;
      if (minUntil > prev) this.coolEphemeral.set(entry.key_id, minUntil);

      return entry;
    }

    return null;
  }

  async _initialFillTimeboxed() {
    if (!this.refillInFlight) {
      const doFill = async () => {
        await this._refillToAtLeast(this.cfg.initialFill);
      };

      this.refillInFlight = doFill().finally(() => {
        this.refillInFlight = null;
      });
    }

    // Timebox: we can't cancel D1 queries, but we can stop awaiting to keep request latency bounded.
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("initial_fill_timeout")), this.cfg.initialFillTimeoutMs),
    );
    return Promise.race([this.refillInFlight, timeout]);
  }

  async _refillToAtLeast(minTotal) {
    const total = this.ringActive.length + this.ringUnknown.length;
    if (total >= minTotal) return;

    const need = minTotal - total;
    // Prefer ACTIVE first, then UNKNOWN.
    let added = 0;
    added += await this._refillStatus(STATUS.ACTIVE, need);
    if (added < need) added += await this._refillStatus(STATUS.UNKNOWN, need - added);

    if (added > 0) await this._persistRingsAndCursors();
  }

  async _refillStatus(status, want) {
    if (!this.shard) return 0;
    if (want <= 0) return 0;

    const lower = this.lower;
    const upper = this.upper;

    let cursorKey = status === STATUS.ACTIVE ? this.cursorActiveKeyid : this.cursorUnknownKeyid;
    if (!cursorKey) cursorKey = lower;

    const limitBase = this.cfg.refillBatch * 2;
    const sql =
      "SELECT key_id, key_plain FROM keys WHERE status=? AND key_id >= ? AND key_id < ? AND key_id > ? ORDER BY key_id LIMIT ?";

    let added = 0;
    let wrapped = false;

    while (added < want) {
      const limit = Math.min(limitBase, (want - added) * 2);
      const res = await this.env.KEY_DB.prepare(sql).bind(status, lower, upper, cursorKey, limit).all();
      const rows = res.results || [];

      if (rows.length === 0) {
        if (wrapped) break;
        cursorKey = lower;
        wrapped = true;
        continue;
      }

      // Always advance cursor to avoid re-scanning the same range even if we skip duplicates.
      cursorKey = rows[rows.length - 1].key_id;

      for (const row of rows) {
        if (added >= want) break;
        const keyId = row.key_id;
        if (this.activeSet.has(keyId) || this.unknownSet.has(keyId)) continue;
        const entry = { key_id: keyId, key_plain: row.key_plain };
        if (status === STATUS.ACTIVE) {
          this.ringActive.push(entry);
          this.activeSet.add(keyId);
        } else {
          this.ringUnknown.push(entry);
          this.unknownSet.add(keyId);
        }
        added += 1;
      }
    }

    if (status === STATUS.ACTIVE) this.cursorActiveKeyid = cursorKey;
    else this.cursorUnknownKeyid = cursorKey;

    return added;
  }

  async _persistRingsAndCursors() {
    // Clamp indices to current ring sizes.
    if (this.ringActive.length > 0) this.cursorIdxActive %= this.ringActive.length;
    if (this.ringUnknown.length > 0) this.cursorIdxUnknown %= this.ringUnknown.length;

    try {
      await this.ctx.storage.put({
        ring_active: this.ringActive,
        ring_unknown: this.ringUnknown,
        cursor_active_keyid: this.cursorActiveKeyid,
        cursor_unknown_keyid: this.cursorUnknownKeyid,
        cursor_idx_active: this.cursorIdxActive,
        cursor_idx_unknown: this.cursorIdxUnknown,
      });
    } catch (e) {
      console.error(`[shard-${safeLogShard(this.shard)}] persist rings failed:`, e?.message || e);
    }
  }

  async _persistCoolMapIfDirty() {
    if (!this.coolDirty) return;
    this.coolDirty = false;

    try {
      await this.ctx.storage.put("cool_map", this.coolPersist);
    } catch (e) {
      // Keep dirty so we retry later in alarm.
      this.coolDirty = true;
      console.error(`[shard-${safeLogShard(this.shard)}] persist cool_map failed:`, e?.message || e);
    }
  }

  async alarm() {
    const now = Date.now();

    // Cleanup expired persisted cooldown entries.
    for (const [keyId, v] of Object.entries(this.coolPersist)) {
      if (!v || typeof v.until_ms !== "number") {
        delete this.coolPersist[keyId];
        this.coolDirty = true;
        continue;
      }
      if (v.until_ms <= now) {
        delete this.coolPersist[keyId];
        this.coolDirty = true;
      }
    }
    await this._persistCoolMapIfDirty();

    // Refill if needed.
    const total = this.ringActive.length + this.ringUnknown.length;
    const target = Math.max(this.cfg.minPoolSize, this.cfg.targetHotPoolSize);
    if (total < target) {
      try {
        await this._refillToAtLeast(target);
      } catch (e) {
        console.error(`[shard-${safeLogShard(this.shard)}] refill failed:`, e?.message || e);
      }
    }

    // Reschedule next alarm.
    const jitter = Math.floor(Math.random() * 30_000);
    try {
      await this.ctx.storage.setAlarm(Date.now() + 60_000 + jitter);
    } catch (e) {
      console.error(`[shard-${safeLogShard(this.shard)}] setAlarm failed:`, e?.message || e);
    }
  }

  async fetch(req) {
    await this._ensureShardFromRequest(req);

    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/lease") {
      const now = Date.now();

      const fromActive = this._pickFromRing(this.ringActive, "active", now);
      if (fromActive) return json({ ...fromActive, pool: "active" });

      const fromUnknown = this._pickFromRing(this.ringUnknown, "unknown", now);
      if (fromUnknown) return json({ ...fromUnknown, pool: "unknown" });

      // Cold start: attempt a small synchronous fill, timeboxed.
      if (this.ringActive.length + this.ringUnknown.length === 0) {
        try {
          await this._initialFillTimeboxed();
        } catch {
          await this._scheduleAlarmSoon();
          return json({ reason: "warming" }, { status: 503 });
        }

        const a2 = this._pickFromRing(this.ringActive, "active", now);
        if (a2) return json({ ...a2, pool: "active" });
        const u2 = this._pickFromRing(this.ringUnknown, "unknown", now);
        if (u2) return json({ ...u2, pool: "unknown" });
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

        const isUnknown = pool === "unknown";
        const maxStreak = isUnknown ? this.cfg.unknownMaxStreak : this.cfg.activeMaxStreak;
        const capMs = isUnknown ? this.cfg.unknownCapMs : this.cfg.activeCapMs;

        const entry = this.coolPersist[keyId] || { until_ms: 0, streak: 0, last_429_at: 0 };
        const last429 = entry.last_429_at || 0;
        // `streak` is an exponent used for the *current* multiplier.
        // We store the *next* exponent (streak+1) after applying it.
        // This means the first 429 uses multiplier 1 (2^0), then 2, 4, 8...
        let streak = entry.streak || 0;
        if (now - last429 > this.cfg.streakDecayMs) streak = 0;
        streak = Math.min(streak, maxStreak);

        ttlMs = ttlMs * Math.pow(2, streak);
        ttlMs = Math.min(ttlMs, capMs);
        ttlMs += Math.floor(ttlMs * 0.1 * Math.random()); // jitter

        entry.until_ms = now + ttlMs;
        entry.streak = Math.min(streak + 1, maxStreak);
        entry.last_429_at = now;

        this.coolPersist[keyId] = entry;
        this.coolDirty = true;
        await this._persistCoolMapIfDirty();

        return json({ ok: true });
      }

      if (outcome === "INVALID" || outcome === "QUOTA") {
        const removed = this._removeKeyEverywhere(keyId);
        if (removed.changed) {
          await this._persistRingsAndCursors();
          this.coolDirty = true;
          await this._persistCoolMapIfDirty();
        }

        // Publish a state transition event (D1 updated asynchronously by queue consumer).
        const type = outcome === "INVALID" ? EVENT_TYPE.MARK_INVALID : EVENT_TYPE.MARK_QUOTA;
        const lastError = payload.error_code || "unknown";
        try {
          await this.env.KEY_EVENTS.send({ type, key_id: keyId, last_error: lastError });
        } catch {
          // Best-effort: DO state is already updated; D1 will be eventually consistent via next events/admin.
        }

        // Ensure we refill soon if pool is running low.
        if (this.ringActive.length + this.ringUnknown.length < this.cfg.minPoolSize) {
          await this._scheduleAlarmSoon();
        }

        return json({ ok: true, removed: removed.found });
      }

      if (outcome === "PROMOTE_OK") {
        // Only promote if it is still in UNKNOWN ring; ignore if already promoted.
        if (this.unknownSet.has(keyId)) {
          const entry = this._removeFromRing(this.ringUnknown, this.unknownSet, keyId);
          if (entry) {
            this.ringActive.push(entry);
            this.activeSet.add(keyId);
            await this._persistRingsAndCursors();
            try {
              await this.env.KEY_EVENTS.send({ type: EVENT_TYPE.PROMOTE_ACTIVE, key_id: keyId });
            } catch {
              // Best-effort.
            }
          }
        }
        return json({ ok: true });
      }

      if (outcome === "ERROR") {
        // Transient upstream/network errors: short, ephemeral cooldown to spread load.
        let ttlMs =
          typeof payload.ttl_ms === "number"
            ? payload.ttl_ms
            : 30_000 + Math.floor(Math.random() * 90_000); // 30s-120s
        ttlMs = clamp(ttlMs, 1_000, 300_000);
        const until = now + ttlMs;
        const prev = this.coolEphemeral.get(keyId) || 0;
        if (until > prev) this.coolEphemeral.set(keyId, until);
        return json({ ok: true });
      }

      return badRequest("Unknown outcome");
    }

    if (req.method === "POST" && url.pathname === "/admin/remove") {
      const payload = await req.json().catch(() => null);
      const ids = Array.isArray(payload?.key_ids) ? payload.key_ids : [];
      if (ids.length === 0) return badRequest("Provide key_ids");

      let changed = false;
      let removed = 0;
      for (const id of ids) {
        const r = this._removeKeyEverywhere(String(id).toLowerCase());
        if (r.found) removed += 1;
        if (r.changed) changed = true;
      }
      if (changed) {
        await this._persistRingsAndCursors();
        this.coolDirty = true;
        await this._persistCoolMapIfDirty();
      }
      return json({ ok: true, removed });
    }

    return json({ error: { message: "Not found" } }, { status: 404 });
  }

  _removeFromRing(ring, set, keyId) {
    const idx = ring.findIndex((k) => k.key_id === keyId);
    if (idx < 0) return null;
    const [entry] = ring.splice(idx, 1);
    set.delete(keyId);
    return entry;
  }

  _removeKeyEverywhere(keyId) {
    let found = false;
    let changed = false;

    const a = this._removeFromRing(this.ringActive, this.activeSet, keyId);
    if (a) {
      found = true;
      changed = true;
    }
    const u = this._removeFromRing(this.ringUnknown, this.unknownSet, keyId);
    if (u) {
      found = true;
      changed = true;
    }

    if (this.coolEphemeral.has(keyId)) this.coolEphemeral.delete(keyId);
    if (this.coolPersist[keyId]) {
      delete this.coolPersist[keyId];
      changed = true;
    }

    return { found, changed };
  }
}
