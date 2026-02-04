#!/usr/bin/env bash
set -euo pipefail

echo "🚀 KeyCycler v3.2 setup helper"
echo "============================="

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js not found"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "❌ npm not found"
  exit 1
fi

echo "📦 Installing deps..."
npm install

echo ""
echo "📋 Next steps (run once per account):"
echo ""
echo "1) Create D1:"
echo "   npx wrangler d1 create keycycler"
echo "   # then update wrangler.toml: [[d1_databases]].database_id"
echo ""
echo "2) Apply migrations:"
echo "   npx wrangler d1 migrations apply keycycler --remote"
echo ""
echo "3) Create Queue:"
echo "   npx wrangler queues create key-events"
echo ""
echo "4) Set secrets:"
echo "   npx wrangler secret put ADMIN_TOKEN"
echo "   npx wrangler secret put AI_GATEWAY_ACCOUNT_ID"
echo "   npx wrangler secret put AI_GATEWAY_NAME"
echo ""
echo "5) Deploy:"
echo "   npm run deploy"
echo ""

