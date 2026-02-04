export function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

function parseDurationMs(s) {
  if (!s) return null;
  const v = String(s).trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return parseInt(v, 10) * 1000;
  const m = v.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.floor(num * mult);
}

function parseRetryAfterMs(retryAfter, nowMs) {
  if (!retryAfter) return null;
  const v = String(retryAfter).trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return parseInt(v, 10) * 1000;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  const delta = t - nowMs;
  return delta > 0 ? delta : 0;
}

export function computeRateLimitTtlMs(headers, nowMs) {
  const retryAfterMs = parseRetryAfterMs(headers.get("retry-after"), nowMs);
  if (retryAfterMs != null && retryAfterMs > 0) return retryAfterMs;

  const resetReq = parseDurationMs(headers.get("x-ratelimit-reset-requests"));
  const resetTok = parseDurationMs(headers.get("x-ratelimit-reset-tokens"));
  const reset = Math.max(resetReq || 0, resetTok || 0);
  if (reset > 0) return reset;

  return 60_000;
}

