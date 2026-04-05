"""Simple disk cache for API responses."""

import hashlib
import json
import os
import time
from pathlib import Path

from riverforecast.constants import CACHE_DIR, CACHE_TTL_SECONDS


def _cache_path() -> Path:
    p = Path(CACHE_DIR)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _key(url: str, params: dict | None = None) -> str:
    raw = url + json.dumps(params or {}, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


def get(url: str, params: dict | None = None, ttl: int = CACHE_TTL_SECONDS) -> dict | None:
    """Return cached JSON response if it exists and is fresh, else None."""
    fp = _cache_path() / f"{_key(url, params)}.json"
    if not fp.exists():
        return None
    age = time.time() - fp.stat().st_mtime
    if age > ttl:
        fp.unlink(missing_ok=True)
        return None
    with open(fp) as f:
        return json.load(f)


def put(url: str, params: dict | None, data: dict) -> None:
    """Store a JSON response in the cache."""
    fp = _cache_path() / f"{_key(url, params)}.json"
    with open(fp, "w") as f:
        json.dump(data, f)


def clear() -> None:
    """Remove all cached files."""
    p = _cache_path()
    for fp in p.glob("*.json"):
        fp.unlink()
