export function isValidHex2(s) {
  return typeof s === "string" && /^[0-9a-f]{2}$/.test(s);
}

export function randomShardHex() {
  const b = crypto.getRandomValues(new Uint8Array(1))[0];
  return b.toString(16).padStart(2, "0");
}

export function shardUpperBound(shardHex) {
  if (shardHex === "ff") return "g"; // greater than any hex prefix
  const n = parseInt(shardHex, 16) + 1;
  return n.toString(16).padStart(2, "0");
}

export function extractShardFromKeyId(keyId) {
  if (typeof keyId !== "string" || keyId.length < 2) return null;
  const shard = keyId.slice(0, 2).toLowerCase();
  return isValidHex2(shard) ? shard : null;
}

