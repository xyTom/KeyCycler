export function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function text(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/plain; charset=utf-8");
  return new Response(data, { ...init, headers });
}

export function badRequest(message) {
  return json({ error: { message } }, { status: 400 });
}

export function unauthorized() {
  return json({ error: { message: "Unauthorized" } }, { status: 401 });
}

