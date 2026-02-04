import { EVENT_TYPE, STATUS } from "../constants.js";
import { splitBatches } from "../lib/batch.js";

export async function handleQueue(batch, env, _ctx) {
  const updates = [];
  const now = Date.now();
  const stmt = env.KEY_DB.prepare("UPDATE keys SET status=?, last_checked=?, last_error=? WHERE key_id=?");

  for (const message of batch.messages) {
    const body = message.body;
    if (!body || typeof body !== "object") continue;
    const type = body.type;
    const keyId = body.key_id;
    const lastError = body.last_error || null;
    if (!keyId) continue;

    if (type === EVENT_TYPE.PROMOTE_ACTIVE) updates.push(stmt.bind(STATUS.ACTIVE, now, null, keyId));
    else if (type === EVENT_TYPE.MARK_INVALID) updates.push(stmt.bind(STATUS.INVALID, now, lastError, keyId));
    else if (type === EVENT_TYPE.MARK_QUOTA) updates.push(stmt.bind(STATUS.QUOTA, now, lastError, keyId));
  }

  // If this throws, the whole batch will be retried according to queue retry settings.
  for (const chunk of splitBatches(updates, 200)) await env.KEY_DB.batch(chunk);
}

