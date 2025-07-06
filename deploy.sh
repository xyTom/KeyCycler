#!/bin/bash

echo "🚀 OpenAI Key Rotator 部署脚本"
echo "================================"

# 检查是否安装了 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js 未安装，请先安装 Node.js"
    exit 1
fi

# 检查是否安装了 npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm 未安装，请先安装 npm"
    exit 1
fi

# 安装依赖
echo "📦 安装依赖中..."
npm install

# 检查是否存在 openai_keys.txt
if [ ! -f "openai_keys.txt" ]; then
    echo "⚠️  未找到 openai_keys.txt 文件"
    echo "📝 正在从示例文件创建..."
    cp openai_keys.txt.example openai_keys.txt
    echo "✅ 已创建 openai_keys.txt，请编辑此文件并添加你的真实 OpenAI API Keys"
    echo "🔧 请编辑 openai_keys.txt 文件，然后重新运行此脚本"
    exit 1
fi

# 检查 openai_keys.txt 是否包含真实的 keys
if grep -q "sk-your-openai-key" openai_keys.txt; then
    echo "⚠️  openai_keys.txt 仍包含示例 Keys"
    echo "🔧 请编辑 openai_keys.txt 文件，添加你的真实 OpenAI API Keys，然后重新运行此脚本"
    exit 1
fi

# 检查是否已安装 wrangler
if ! command -v wrangler &> /dev/null; then
    echo "📥 安装 Wrangler..."
    npm install -g wrangler
fi

# 登录 Cloudflare（如果需要）
echo "🔐 检查 Cloudflare 登录状态..."
if ! wrangler whoami &> /dev/null; then
    echo "📝 需要登录 Cloudflare，请按照提示操作..."
    wrangler login
fi

# 检查 wrangler.toml 中的 KV ID
if grep -q "<production_kv_id>" wrangler.toml; then
    echo "🗄️  创建 KV 命名空间..."
    
    echo "📋 创建生产环境 KV..."
    PROD_KV=$(wrangler kv:namespace create COOL | grep -o 'id = "[^"]*"' | cut -d'"' -f2)
    
    echo "📋 创建预览环境 KV..."
    PREVIEW_KV=$(wrangler kv:namespace create COOL --preview | grep -o 'id = "[^"]*"' | cut -d'"' -f2)
    
    # 更新 wrangler.toml
    sed -i.bak "s/<production_kv_id>/$PROD_KV/g" wrangler.toml
    sed -i.bak "s/<preview_kv_id>/$PREVIEW_KV/g" wrangler.toml
    rm wrangler.toml.bak
    
    echo "✅ KV 命名空间创建完成"
    echo "📝 已更新 wrangler.toml 配置"
fi

echo ""
echo "🎉 设置完成！"
echo ""
echo "📋 下一步："
echo "1. 本地开发：npm run dev"
echo "2. 部署到生产：npm run deploy"
echo ""
echo "🔗 部署后，你将获得一个类似这样的 URL："
echo "   https://openai-key-rotator-kv.your-subdomain.workers.dev"
echo ""
echo "💡 使用方法："
echo "   将 Worker URL 替换 api.openai.com 即可使用"
