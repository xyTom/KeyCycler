import { json } from "../lib/http.js";
import { randomShardHex } from "../lib/shard.js";
import { computeRateLimitTtlMs } from "../lib/rate_limit.js";
import { durableLease, durableReport } from "../lib/durable.js";
import { callUpstream, mirrorUpstream, readUpstreamErrorCode } from "../lib/upstream.js";

export async function handleProxyRequest(req, env, ctx) {
  const requestBody = req.body ? await req.arrayBuffer() : null;

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const shard = randomShardHex();
    let lease;
    try {
      lease = await durableLease(env, shard);
    } catch (_e) {
      // Try another shard if warming/empty/overloaded.
      continue;
    }

    const { key_id: keyId, key_plain: keyPlain, pool } = lease;
    const upstream = await callUpstream(req, env, keyPlain, requestBody);

    // Rate limited: must await report to avoid immediate reuse.
    if (upstream.status === 429) {
      const ttlMs = computeRateLimitTtlMs(upstream.headers, Date.now());
      await durableReport(env, shard, {
        key_id: keyId,
        pool,
        outcome: "RATE_LIMIT",
        ttl_ms: ttlMs,
        headers: {
          retry_after: upstream.headers.get("retry-after"),
          reset_requests: upstream.headers.get("x-ratelimit-reset-requests"),
          reset_tokens: upstream.headers.get("x-ratelimit-reset-tokens"),
        },
      });
      continue;
    }

    // Auth/quota errors: parse JSON error code if present.
    if (upstream.status === 401 || upstream.status === 403) {
      const clone = upstream.clone();
      const code = await readUpstreamErrorCode(clone);
      if (code === "invalid_api_key") {
        await durableReport(env, shard, { key_id: keyId, pool, outcome: "INVALID", error_code: code });
        continue;
      }
      if (code === "insufficient_quota") {
        await durableReport(env, shard, { key_id: keyId, pool, outcome: "QUOTA", error_code: code });
        continue;
      }
    }

    // Upstream/server/network errors are usually not key-specific; do not retry.
    if (upstream.status >= 500) {
      ctx.waitUntil(durableReport(env, shard, { key_id: keyId, pool, outcome: "ERROR" }).catch(() => {}));
      return mirrorUpstream(upstream);
    }

    // Opportunistic promote: if it worked and came from UNKNOWN pool, promote in background.
    if (pool === "unknown") {
      ctx.waitUntil(durableReport(env, shard, { key_id: keyId, pool, outcome: "PROMOTE_OK" }).catch(() => {}));
    }

    return mirrorUpstream(upstream);
  }

  return json({ error: { message: "No available keys (warming/cooling)" } }, { status: 503 });
}

