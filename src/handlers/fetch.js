import { STATUS } from "../constants.js";
import { requireAdmin } from "../lib/auth.js";
import { json, text, unauthorized } from "../lib/http.js";
import { adminEnableDisable, adminImportKeys, adminStats } from "./admin.js";
import { handleProxyRequest } from "./proxy.js";

export async function handleFetch(req, env, ctx) {
  const url = new URL(req.url);

  // Admin APIs
  if (url.pathname.startsWith("/admin/")) {
    if (!requireAdmin(req, env)) return unauthorized();

    if (url.pathname === "/admin/keys/import") return adminImportKeys(req, env);
    if (url.pathname === "/admin/stats") return adminStats(req, env);
    if (url.pathname === "/admin/keys/disable") return adminEnableDisable(req, env, { status: STATUS.INVALID });
    if (url.pathname === "/admin/keys/enable") return adminEnableDisable(req, env, { status: STATUS.ACTIVE });

    return json({ error: { message: "Not found" } }, { status: 404 });
  }

  // OpenAI-compatible proxy
  if (url.pathname.startsWith("/v1/")) {
    return handleProxyRequest(req, env, ctx);
  }

  return text("Not Found", { status: 404 });
}

