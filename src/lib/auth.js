function parseBearerToken(authHeader) {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

export function requireAdmin(req, env) {
  const token = parseBearerToken(req.headers.get("authorization"));
  return typeof env.ADMIN_TOKEN === "string" && env.ADMIN_TOKEN.length > 0 && token === env.ADMIN_TOKEN;
}

