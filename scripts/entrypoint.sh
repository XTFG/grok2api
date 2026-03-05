#!/usr/bin/env sh
set -eu

if [ -n "${CUSTOM_GROK_URL:-}" ]; then
    echo "检测到 CUSTOM_GROK_URL，已启用运行时 URL 替换（不再执行代码全局 sed）"
fi

if [ -n "${CUSTOM_ASSETS_URL:-}" ]; then
    echo "检测到 CUSTOM_ASSETS_URL，已启用运行时 URL 替换（不再执行代码全局 sed）"
fi

/app/scripts/init_storage.sh

exec "$@"
