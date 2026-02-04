import { json } from "./http.js";

function isJsonResponse(resp) {
  const ct = resp.headers.get("content-type") || "";
  return ct.toLowerCase().includes("application/json");
}

export async function readUpstreamErrorCode(resp) {
  if (!isJsonResponse(resp)) return null;
  try {
    const data = await resp.json();
    return data?.error?.code || null;
  } catch {
    return null;
  }
}

export function buildGatewayUrl(origUrl, env) {
  const url = new URL(origUrl);
  const accountId = env.AI_GATEWAY_ACCOUNT_ID || "84d85b35ee225a9bcc9f41df796aacb9";
  const gatewayName = env.AI_GATEWAY_NAME || "openai-worker";
  // This worker exposes an OpenAI-compatible surface under `/v1/*`.
  // Cloudflare AI Gateway's OpenAI provider endpoint treats `/openai/*` as the OpenAI `/v1/*` surface,
  // so we strip the leading `/v1` here.
  let openaiPath = url.pathname;
  if (openaiPath === "/v1") openaiPath = "";
  else if (openaiPath.startsWith("/v1/")) openaiPath = openaiPath.slice(3);
  url.protocol = "https:";
  url.port = "";
  url.hostname = "gateway.ai.cloudflare.com";
  url.pathname = `/v1/${accountId}/${gatewayName}/openai${openaiPath}`;
  return url;
}

export async function callUpstream(origReq, env, apiKey, requestBody) {
  const url = buildGatewayUrl(origReq.url, env);

  const init = {
    method: origReq.method,
    headers: new Headers(origReq.headers),
    body: requestBody,
    cf: { cacheEverything: false },
  };

  // Validate and sanitize API key before setting header to avoid "Invalid header value" errors.
  // (e.g. accidental trailing newline / control characters when imported from files)
  const safeKey = String(apiKey ?? "")
    .trim()
    .replace(/[\u0000-\u001F\u007F]/g, "");
  if (!safeKey || safeKey.length < 10) {
    return json(
      { error: { message: "Invalid API key in pool", type: "configuration_error" } },
      { status: 500 },
    );
  }
  init.headers.set("authorization", `Bearer ${safeKey}`);

  // Strip Cloudflare and hop-by-hop-ish headers.
  init.headers.delete("host");
  init.headers.delete("cf-ray");
  init.headers.delete("cf-connecting-ip");
  init.headers.delete("cf-ipcountry");
  init.headers.delete("cf-visitor");
  init.headers.delete("x-forwarded-for");
  init.headers.delete("x-forwarded-proto");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);
  init.signal = controller.signal;

  try {
    const resp = await fetch(url, init);
    clearTimeout(timeoutId);
    return resp;
  } catch (_err) {
    clearTimeout(timeoutId);
    return json(
      {
        error: {
          message: "Request failed",
          type: "network_error",
        },
      },
      { status: 502 },
    );
  }
}

export function mirrorUpstream(resp) {
  // Return streaming response without consuming body.
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}
