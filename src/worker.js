import keysTxt from './openai_keys.txt';

const ALL_KEYS = keysTxt.trim().split(/\r?\n/).map(k => k.trim()).filter(Boolean);
const MAX_SCAN_KEYS = 15;                                      // 子请求安全窗口

export default {
  async fetch(req, env, ctx) {
    // 克隆请求体，避免多次使用时被消费
    const requestBody = req.body ? await req.arrayBuffer() : null;
    
    // 随机平移窗口，均匀利用所有 Key
    const offset = Math.floor(Math.random() * ALL_KEYS.length);
    console.log(`Starting key rotation with offset: ${offset}, total keys: ${ALL_KEYS.length}`);

    let scanned = 0;
    for (let i = 0; scanned < MAX_SCAN_KEYS && i < ALL_KEYS.length; i++, scanned++) {
      const key = ALL_KEYS[(offset + i) % ALL_KEYS.length];
      console.log(`Trying key ${scanned + 1}/${MAX_SCAN_KEYS}: ${key.slice(0, 20)}...`);
      
      /* ---------- ① 查 KV，看是否在冷却 ---------- */
      try {
        if (await env.COOL.get(key)) {
          console.log(`Key ${key.slice(0, 20)}... is cooling, skipping`);
          continue;
        }
      } catch (error) {
        console.error(`Error checking KV for key ${key.slice(0, 20)}...:`, error.message);
        continue;
      }

      /* ---------- ② 调用 OpenAI ---------- */
      console.log(`Calling OpenAI with key ${key.slice(0, 20)}...`);
      const up = await callOpenAI(req, key, requestBody);
      console.log(`OpenAI response status: ${up.status} for key ${key.slice(0, 10)}...`);
      
      if (up.status !== 429) {
        console.log(`Returning response with status ${up.status}, scan completed`);
        return mirrorHeaders(up);         // 成功，直接返回流式响应
      }

      /* ---------- ③ 触发限流：写 KV 并设置 TTL ---------- */
      const ttl = calcTtl(up);                                 // 秒
      console.log(`Key ${key.slice(0, 20)}... hit rate limit, cooling for ${ttl}s`);
      ctx.waitUntil(env.COOL.put(key, 'cooling', { expirationTtl: ttl }));
    }

    console.log(`All keys exhausted or cooling. Scanned: ${scanned} keys`);
    return new Response('OpenAI keys cooling or exhausted', { status: 503 });
  }
};

/* ----- 工具函数 ----- */

// 60 s–24 h 动态 TTL（+10 % 抖动）
function calcTtl(r) {
  const retry = parseInt(r.headers.get('retry-after') || '0', 10);
  const reset = parseInt(r.headers.get('x-ratelimit-reset-requests') || '0', 10);
  let ttl = retry > 0 ? retry : reset || 60;
  ttl = Math.min(Math.max(ttl, 60), 86_400);
  ttl += Math.floor(ttl * 0.1 * Math.random());
  return ttl;
}

function mirrorHeaders(up) {
  // 直接返回流式响应，不读取 body
  const out = new Response(up.body, {
    status: up.status,
    statusText: up.statusText,
    headers: up.headers
  });
  
  // 只复制必要的限流头部
  ['x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests'].forEach(h => {
    const v = up.headers.get(h);
    if (v) out.headers.set(h, v);
  });
  
  return out;
}

async function callOpenAI(orig, key, requestBody) {
  const url = new URL(orig.url);
  url.hostname = 'gateway.ai.cloudflare.com';
  // Cloudflare AI Gateway 格式：保留完整的原始路径
  url.pathname = `/v1/84d85b35ee225a9bcc9f41df796aacb9/openai-worker/openai${url.pathname}`;

  const init = {
    method: orig.method,
    headers: new Headers(orig.headers),
    body: requestBody, // 使用预先读取的请求体
    cf: { cacheEverything: false }
  };

  // 设置 Authorization 并清理 CF 头部
  init.headers.set('Authorization', `Bearer ${key}`);
  init.headers.delete('host');
  init.headers.delete('cf-ray');
  init.headers.delete('cf-connecting-ip');
  init.headers.delete('cf-ipcountry');
  init.headers.delete('cf-visitor');
  init.headers.delete('x-forwarded-for');
  init.headers.delete('x-forwarded-proto');

  // 超时控制 (30秒)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  init.signal = controller.signal;

  try {
    const response = await fetch(url, init);
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    // 超时或网络错误返回 500
    return new Response(JSON.stringify({
      error: {
        message: 'Request failed',
        type: 'network_error'
      }
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
