# KeyCycler (Pro)

基于 Cloudflare Workers + Durable Objects + D1 + Queues 的 OpenAI API Key 调度/轮换系统。

面向「Key 很多（可达 100 万）、单 Key RPM 很低（例如 3）、高并发」场景：通过 **DO 调度** 做主动限频与冷却，显著减少 429；D1 只存长期状态（UNKNOWN/ACTIVE/INVALID/QUOTA），避免频繁写库；Queues 仅处理状态迁移。 如果使用场景是「Key 不多（低于 1万）、单 Key RPM 很高（例如 100）、高并发」，则需要考虑使用普通版本，架构更加简洁高效，节省资源，代码在main分支上。

## 核心特性

- 256 分片（`key_id` 前 2 个 hex 字符）+ 每分片一个 DO，水平扩展
- 双热池：`ring_active` 优先，`ring_unknown` 兜底，冷启动可用
- 渐进验证：UNKNOWN 被用到且请求非鉴权失败时自动提升为 ACTIVE
- 429 冷却持久化：`cool_map` 写入 DO storage，DO 重启不丢冷却
- 写放大控制：成功请求不写 D1、不发 Queue；仅状态迁移写入

## 架构概览

- Worker `/v1/*`：代理到 Cloudflare AI Gateway（OpenAI provider）
- DO `KeyShard`：发放 key（lease）+ 处理 429/失效/额度耗尽（report）+ alarm 补池
- D1 `keys`：长期状态与管理查询
- Queue `key-events`：只写入状态迁移（PROMOTE/INVALID/QUOTA）

## 部署步骤

### 1) 安装依赖

```bash
npm install
```

### 2) 创建 D1 数据库

```bash
npx wrangler d1 create keycycler
```

把输出里的 `database_id` 填到 `wrangler.toml` 的 `[[d1_databases]]`。

### 3) 应用迁移

远端（生产）：

```bash
npx wrangler d1 migrations apply keycycler --remote
```

本地开发：

```bash
npx wrangler d1 migrations apply keycycler --local
```

### 4) 创建 Queue

```bash
npx wrangler queues create key-events
```

### 5) 配置 Secrets

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put AI_GATEWAY_ACCOUNT_ID
npx wrangler secret put AI_GATEWAY_NAME
```

说明：
- `ADMIN_TOKEN`：管理接口鉴权
- `AI_GATEWAY_ACCOUNT_ID`：Cloudflare AI Gateway account/project id
- `AI_GATEWAY_NAME`：你在 AI Gateway 里创建的 gateway 名称（示例：`openai-worker`）

### 6) 部署

```bash
npm run deploy
```

## 使用方法

### 1) 导入 Keys（分批）

一次最多建议 1 万行（服务端会截断），建议客户端循环调用导完 100 万。

```bash
curl -X POST "https://<your-worker>/admin/keys/import" \\
  -H "Authorization: Bearer $ADMIN_TOKEN" \\
  -H "Content-Type: text/plain" \\
  --data-binary @openai_keys.txt
```

### 2) 作为 OpenAI 代理使用

```bash
curl "https://<your-worker>/v1/chat/completions" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

### 3) 查看统计

```bash
curl "https://<your-worker>/admin/stats" \\
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### 4) 禁用/启用 Keys

禁用（会同步通知 DO 立即移出热池）：

```bash
curl -X POST "https://<your-worker>/admin/keys/disable" \\
  -H "Authorization: Bearer $ADMIN_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"key_ids":["<sha256hex>","<sha256hex>"]}'
```

启用：

```bash
curl -X POST "https://<your-worker>/admin/keys/enable" \\
  -H "Authorization: Bearer $ADMIN_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"key_ids":["<sha256hex>"]}'
```

## 可调参数（环境变量）

以下都为可选（有默认值）：

- `DEFAULT_RPM`（默认 3）
- `EXPECTED_GLOBAL_RPS`（默认 2000）
- `SAFETY`（默认 2.0）
- `MIN_POOL_SIZE`（默认 300）
- `REFILL_BATCH`（默认 200）
- `INITIAL_FILL`（默认 200）
- `INITIAL_FILL_TIMEOUT_MS`（默认 3000）

## 注意事项

- 该项目不会在日志中打印明文 key（只可能出现 key_id 前缀）
- D1 仅存长期状态，不存分钟级冷却；冷却由 DO storage 持久化
- 如果你希望在高峰期进一步降低 429，通常优先调大 `EXPECTED_GLOBAL_RPS` / `SAFETY` 以提升 DO 热池目标

