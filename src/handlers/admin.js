import { STATUS } from "../constants.js";
import { badRequest, json } from "../lib/http.js";
import { parseLines, splitBatches } from "../lib/batch.js";
import { sha256Hex } from "../lib/crypto.js";
import { extractShardFromKeyId } from "../lib/shard.js";
import { durableAdminRemove } from "../lib/durable.js";

export async function adminImportKeys(req, env) {
  if (req.method !== "POST") return badRequest("Use POST");

  const body = await req.text();
  const keys = parseLines(body, { maxLines: 10_000 });
  if (keys.length === 0) return badRequest("No keys provided");

  const now = Date.now();
  const insertStmt = env.KEY_DB.prepare(
    "INSERT OR IGNORE INTO keys (key_id, key_plain, status, last_checked, last_error) VALUES (?, ?, ?, ?, ?)",
  );

  let inserted = 0;
  let skipped = 0;

  // Hashing is CPU-expensive; keep batches small to stay within Worker limits.
  for (const chunk of splitBatches(keys, 500)) {
    const statements = [];
    const hashed = await Promise.all(chunk.map((k) => sha256Hex(k)));
    for (let i = 0; i < chunk.length; i++) {
      const keyPlain = chunk[i];
      const keyId = hashed[i];
      statements.push(insertStmt.bind(keyId, keyPlain, STATUS.UNKNOWN, now, null));
    }
    const results = await env.KEY_DB.batch(statements);
    for (const r of results) {
      const changes = r?.meta?.changes || 0;
      if (changes > 0) inserted += changes;
      else skipped += 1;
    }
  }

  return json({ received: keys.length, inserted, skipped });
}

export async function adminStats(_req, env) {
  const out = await env.KEY_DB.prepare("SELECT status, COUNT(*) AS cnt FROM keys GROUP BY status").all();
  const counts = {};
  let total = 0;
  for (const row of out.results || []) {
    counts[row.status] = row.cnt;
    total += row.cnt;
  }
  return json({ total, counts });
}

export async function adminEnableDisable(req, env, { status }) {
  if (req.method !== "POST") return badRequest("Use POST");
  const payload = await req.json().catch(() => null);
  if (!payload || typeof payload !== "object") return badRequest("Invalid JSON");

  const keysPlain = Array.isArray(payload.keys) ? payload.keys : null;
  const keyIdsIn = Array.isArray(payload.key_ids) ? payload.key_ids : null;

  if ((!keysPlain || keysPlain.length === 0) && (!keyIdsIn || keyIdsIn.length === 0)) {
    return badRequest("Provide `keys` or `key_ids`");
  }

  const now = Date.now();
  let keyIds = [];
  if (keyIdsIn && keyIdsIn.length > 0) {
    keyIds = keyIdsIn.map((k) => String(k).trim().toLowerCase()).filter(Boolean);
  } else {
    const plain = keysPlain.map((k) => String(k).trim()).filter(Boolean);
    const hashed = await Promise.all(plain.map((k) => sha256Hex(k)));
    keyIds = hashed;
  }

  // Update D1.
  const stmt = env.KEY_DB.prepare("UPDATE keys SET status=?, last_checked=?, last_error=? WHERE key_id=?");
  for (const chunk of splitBatches(keyIds, 500)) {
    const statements = chunk.map((id) => stmt.bind(status, now, null, id));
    await env.KEY_DB.batch(statements);
  }

  // For disable, remove immediately from DO rings to prevent further leases.
  if (status === STATUS.INVALID) {
    const byShard = new Map();
    for (const id of keyIds) {
      const shard = extractShardFromKeyId(id);
      if (!shard) continue;
      if (!byShard.has(shard)) byShard.set(shard, []);
      byShard.get(shard).push(id);
    }

    await Promise.all(
      Array.from(byShard.entries()).map(async ([shard, ids]) => {
        // Internal admin remove does not publish queue events (D1 already updated).
        try {
          await durableAdminRemove(env, shard, ids);
        } catch {
          // Best-effort: D1 is already updated; DO will eventually refill without these keys.
        }
      }),
    );
  }

  return json({ updated: keyIds.length, status });
}

