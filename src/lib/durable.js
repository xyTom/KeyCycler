function shardStub(ns, shardHex) {
  const name = `shard-${shardHex}`;
  if (typeof ns.getByName === "function") return ns.getByName(name);
  const id = ns.idFromName(name);
  return ns.get(id);
}

export async function durableLease(env, shardHex) {
  const stub = shardStub(env.KEY_SHARD, shardHex);
  const resp = await stub.fetch("https://do/lease", {
    method: "POST",
    headers: { "x-shard": shardHex },
  });
  if (!resp.ok) {
    let reason = "unknown";
    try {
      const data = await resp.json();
      reason = data?.reason || reason;
    } catch {
      // ignore
    }
    const e = new Error(`lease_failed:${resp.status}:${reason}`);
    e.status = resp.status;
    e.reason = reason;
    throw e;
  }
  return resp.json();
}

export async function durableReport(env, shardHex, payload) {
  const stub = shardStub(env.KEY_SHARD, shardHex);
  return stub.fetch("https://do/report", {
    method: "POST",
    headers: { "content-type": "application/json", "x-shard": shardHex },
    body: JSON.stringify(payload),
  });
}

export async function durableAdminRemove(env, shardHex, keyIds) {
  const stub = shardStub(env.KEY_SHARD, shardHex);
  return stub.fetch("https://do/admin/remove", {
    method: "POST",
    headers: { "content-type": "application/json", "x-shard": shardHex },
    body: JSON.stringify({ key_ids: keyIds }),
  });
}

