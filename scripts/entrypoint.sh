#!/usr/bin/env sh
set -eu

# 自定义 API 地址替换
# 如果设置了 CUSTOM_GROK_URL 环境变量，则替换 https://grok.com
# 如果设置了 CUSTOM_ASSETS_URL 环境变量，则替换 https://assets.grok.com

if [ -n "${CUSTOM_GROK_URL:-}" ]; then
    echo "正在替换 grok.com 为: $CUSTOM_GROK_URL"
    find /app -name "*.py" -type f -exec sed -i "s|https://grok.com|${CUSTOM_GROK_URL}|g" {} \;
fi

if [ -n "${CUSTOM_ASSETS_URL:-}" ]; then
    echo "正在替换 assets.grok.com 为: $CUSTOM_ASSETS_URL"
    find /app -name "*.py" -type f -exec sed -i "s|https://assets.grok.com|${CUSTOM_ASSETS_URL}|g" {} \;
fi

/app/scripts/init_storage.sh

exec "$@"
