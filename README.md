# KeyCycler
这是一个基于 Cloudflare Workers 和 KV 存储的 API Key 轮换系统，能够自动管理多个 API Key，处理限流情况，并实现智能切换。

## 功能特点

- 🔄 **智能 Key 轮换**：随机起点扫描，均匀利用所有 Key
- ❄️ **冷却机制**：遇到 429 限流时自动将 Key 放入冷却池
- ⏰ **动态 TTL**：根据 OpenAI 返回的限制头精准设置冷却时间
- 🌍 **全局一致性**：使用 Cloudflare KV 实现跨区域状态同步
- ⚡ **高性能**：KV 读操作本地 PoP 纳秒级返回
- 🛡️ **限制保护**：单次请求最多尝试 15 个 Key，避免触发子请求限制

## 部署步骤

### 1. 克隆项目

```bash
git clone <your-repo-url>
cd KeyCycler
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置 OpenAI Keys

编辑 `openai_keys.txt` 文件，每行放一个 OpenAI API Key：

```
sk-your-openai-key-1
sk-your-openai-key-2
sk-your-openai-key-3
```

### 4. 创建 KV 命名空间

```bash
# 创建生产环境 KV
npm run kv:create

# 创建预览环境 KV
npm run kv:create-preview
```

执行后会得到类似输出：
```
🌀 Creating namespace with title "openai-key-rotator-kv-COOL"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "COOL", id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
```

### 5. 更新 wrangler.toml

将上一步得到的 KV ID 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "COOL"
id = "your-production-kv-id"
preview_id = "your-preview-kv-id"
```

### 6. 本地开发

```bash
npm run dev
```

访问 `http://localhost:8787` 测试

### 7. 部署到生产

```bash
npm run deploy
```

## 使用方法

部署后，你的 Worker 会获得一个 URL（如 `https://your-worker.your-subdomain.workers.dev`）。

直接将这个 URL 作为 OpenAI API 的代理使用：

```bash
curl https://your-worker.your-subdomain.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

或在代码中使用：

```javascript
const response = await fetch('https://your-worker.your-subdomain.workers.dev/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'gpt-3.5-turbo',
    messages: [{ role: 'user', content: 'Hello!' }]
  })
});
```

## 工作原理

1. **随机选择起点**：每次请求从随机位置开始扫描 Key 列表
2. **检查冷却状态**：查询 KV 存储，跳过正在冷却的 Key
3. **调用 OpenAI API**：使用可用的 Key 发起请求
4. **处理限流**：收到 429 响应时，将 Key 写入 KV 并设置 TTL
5. **智能重试**：最多尝试 15 个 Key，避免无限循环

## 配置说明

### TTL 计算策略

- 优先使用 `Retry-After` 头
- 其次使用 `x-ratelimit-reset-requests` 头
- 默认 60 秒，最小 30 秒，最大 24 小时
- 添加 10% 随机抖动防止雪崩

### 子请求限制

- 每个 Key 最多 2 个子请求（KV get + OpenAI fetch）
- 单次请求最多扫描 15 个 Key
- 总计不超过 45 个子请求，安全低于 50 限制

## 监控和调试

### 查看 KV 存储状态

```bash
wrangler kv:key list --binding COOL
```

### 查看特定 Key 的冷却状态

```bash
wrangler kv:key get "sk-your-key" --binding COOL
```

### 手动清除冷却状态

```bash
wrangler kv:key delete "sk-your-key" --binding COOL
```

## 注意事项

- ⚠️ 请妥善保管 `openai_keys.txt` 文件，不要提交到公共仓库
- 🔄 KV 状态传播到全网可能需要 ~60 秒
- 📊 建议至少配置 5-10 个 API Key 以获得最佳效果
- 💰 注意 Cloudflare Workers 的计费规则和使用限制

## 许可证

MIT License