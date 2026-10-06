"""Paths and environment configuration.

Real data and secrets live OUTSIDE the git checkout:

    TIMELINE_DATA_DIR     default ~/.location-platform/timeline
    TIMELINE_SECRETS_DIR  default ~/.location-platform/secrets/timeline

Other knobs:

    TIMELINE_SOURCE                   geller | synthetic | local_db   (default geller)
    TIMELINE_LOCAL_DB                 path of an existing odlh-storage.db (local_db source)
    TIMELINE_KEEP_EXPORTS             timestamped exports to keep (default 10)
    TIMELINE_DEFAULT_UTC_OFFSET_MIN   seed UTC offset for leading timelinePath rows (default 120,
                                      same as upstream odlh_export.py)
    TIMELINE_LOG_LEVEL                DEBUG|INFO|WARNING|ERROR (default INFO)
"""
from __future__ import annotations

import os
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Mapping, Optional

DEFAULT_HOME = "~/.location-platform"
SOURCES = ("geller", "synthetic", "local_db")


def _platform_home(env: Mapping[str, str]) -> str:
    """Base dir for all real data + secrets, shared with the Node side.

    Honors LOCATION_PLATFORM_HOME so a single env var configures the whole platform;
    the per-project TIMELINE_DATA_DIR / TIMELINE_SECRETS_DIR still override it.
    """
    return os.path.expanduser(env.get("LOCATION_PLATFORM_HOME") or DEFAULT_HOME)


class ConfigError(ValueError):
    pass


def _int_env(env: Mapping[str, str], name: str, default: int, lo: int, hi: int) -> int:
    raw = env.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        val = int(raw.strip())
    except ValueError:
        raise ConfigError(f"{name} must be an integer") from None
    if not lo <= val <= hi:
        raise ConfigError(f"{name} must be between {lo} and {hi}")
    return val


@dataclass(frozen=True)
class Config:
    data_dir: Path
    secrets_dir: Path
    source: str = "geller"
    local_db: Optional[Path] = None
    keep_exports: int = 10
    default_utc_offset_min: int = 120
    names_max_per_run: int = 150

    # ---- data layout (see schemas/TIMELINE_EXPORT_CONTRACT.md) ----
    @property
    def raw_dir(self) -> Path:
        return self.data_dir / "raw"

    @property
    def raw_db(self) -> Path:
        return self.raw_dir / "odlh-storage.db"

    @property
    def exports_dir(self) -> Path:
        return self.data_dir / "exports"

    @property
    def current_dir(self) -> Path:
        return self.data_dir / "current"

    @property
    def current_export(self) -> Path:
        return self.current_dir / "Timeline.json"

    @property
    def current_full(self) -> Path:
        return self.current_dir / "Timeline-full.json"

    @property
    def state_dir(self) -> Path:
        return self.data_dir / "state"

    @property
    def status_file(self) -> Path:
        return self.state_dir / "sync-status.json"

    @property
    def lock_file(self) -> Path:
        return self.state_dir / "sync.lock"

    # ---- secrets layout ----
    @property
    def master_file(self) -> Path:
        return self.secrets_dir / "master.txt"

    @property
    def key_file(self) -> Path:
        return self.secrets_dir / "key.b64"

    @property
    def android_id_file(self) -> Path:
        return self.secrets_dir / "android_id"

    @property
    def account_file(self) -> Path:
        return self.secrets_dir / "account.json"

    @property
    def places_key_file(self) -> Path:
        """Google Places API (New) key used by `timeline-sync names`."""
        return self.secrets_dir / "places_api_key.txt"

    # ---- place-name enrichment ----
    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @property
    def names_cache(self) -> Path:
        """Places API cache (keyed by featureId), upstream-compatible, shared with build_records."""
        return self.cache_dir / "place_cache_api.json"

    @property
    def names_browser_cache(self) -> Path:
        """Headless-browser cache written by upstream resolve_names.js (keyed by featureId)."""
        return self.cache_dir / "place_cache_browser.json"

    def with_overrides(self, **kw) -> "Config":
        return replace(self, **{k: v for k, v in kw.items() if v is not None})

    @classmethod
    def from_env(cls, env: Optional[Mapping[str, str]] = None, **overrides) -> "Config":
        env = os.environ if env is None else env
        home = _platform_home(env)
        data = Path(os.path.expanduser(env.get("TIMELINE_DATA_DIR") or os.path.join(home, "timeline")))
        sec = Path(os.path.expanduser(env.get("TIMELINE_SECRETS_DIR") or os.path.join(home, "secrets", "timeline")))
        source = (env.get("TIMELINE_SOURCE") or "geller").strip().lower()
        if source not in SOURCES:
            raise ConfigError(f"TIMELINE_SOURCE must be one of {', '.join(SOURCES)}")
        local_db = env.get("TIMELINE_LOCAL_DB")
        cfg = cls(
            data_dir=data,
            secrets_dir=sec,
            source=source,
            local_db=Path(os.path.expanduser(local_db)) if local_db else None,
            keep_exports=_int_env(env, "TIMELINE_KEEP_EXPORTS", 10, 1, 10_000),
            default_utc_offset_min=_int_env(env, "TIMELINE_DEFAULT_UTC_OFFSET_MIN", 120, -900, 900),
            names_max_per_run=_int_env(env, "TIMELINE_NAMES_MAX_PER_RUN", 150, 1, 5000),
        )
        cfg = cfg.with_overrides(**overrides)
        if cfg.source not in SOURCES:
            raise ConfigError(f"source must be one of {', '.join(SOURCES)}")
        return cfg
