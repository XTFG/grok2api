"""Runtime URL rewrite helpers for reverse HTTP/WS requests."""

import os
from typing import Any, Mapping

from app.core.config import get_config

_SKIP_HEADER_REWRITE_KEYS = {
    "origin",
    "referer",
    "host",
    "sec-websocket-origin",
}


def _normalize_rule_value(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()


def _build_config_rules() -> dict[str, str]:
    raw_rules = get_config("endpoint.replace_map") or {}
    if not isinstance(raw_rules, dict):
        return {}

    rules: dict[str, str] = {}
    for source, target in raw_rules.items():
        src = _normalize_rule_value(source)
        dst = _normalize_rule_value(target)
        if not src or not dst:
            continue
        rules[src] = dst
    return rules


def _build_legacy_env_rules() -> dict[str, str]:
    rules: dict[str, str] = {}
    custom_grok = _normalize_rule_value(os.getenv("CUSTOM_GROK_URL"))
    custom_assets = _normalize_rule_value(os.getenv("CUSTOM_ASSETS_URL"))

    if custom_grok:
        rules["https://grok.com"] = custom_grok
        if custom_grok.startswith("https://"):
            rules["wss://grok.com"] = f"wss://{custom_grok[8:]}"
            rules["ws://grok.com"] = f"ws://{custom_grok[8:]}"
        elif custom_grok.startswith("http://"):
            rules["wss://grok.com"] = f"ws://{custom_grok[7:]}"
            rules["ws://grok.com"] = f"ws://{custom_grok[7:]}"

    if custom_assets:
        rules["https://assets.grok.com"] = custom_assets

    return rules


def get_rewrite_rules() -> list[tuple[str, str]]:
    """
    Build runtime rewrite rules sorted by source length (desc) to avoid prefix shadowing.
    """
    rules = _build_config_rules()
    legacy_rules = _build_legacy_env_rules()
    if legacy_rules:
        rules.update(legacy_rules)

    pairs = [(src, dst) for src, dst in rules.items() if src != dst]
    pairs.sort(key=lambda item: len(item[0]), reverse=True)
    return pairs


def rewrite_url(url: Any) -> Any:
    """Rewrite URL string by configured source-prefix map."""
    if not isinstance(url, str):
        return url

    for source, target in get_rewrite_rules():
        if url.startswith(source):
            return f"{target}{url[len(source):]}"
    return url


def rewrite_headers(headers: Any) -> Any:
    """Rewrite URL-like header values (Origin/Referer/etc) if they match rewrite rules."""
    if not isinstance(headers, Mapping):
        return headers

    changed = False
    rewritten: dict[Any, Any] = {}
    for key, value in headers.items():
        key_lower = str(key).lower()
        if key_lower in _SKIP_HEADER_REWRITE_KEYS:
            rewritten[key] = value
            continue

        new_value = rewrite_url(value) if isinstance(value, str) else value
        rewritten[key] = new_value
        if new_value != value:
            changed = True
    return rewritten if changed else headers


__all__ = ["get_rewrite_rules", "rewrite_url", "rewrite_headers"]
