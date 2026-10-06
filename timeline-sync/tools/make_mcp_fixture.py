"""Regenerate the committed synthetic fixtures used by timeline-mcp's tests.

    .venv/Scripts/python tools/make_mcp_fixture.py            # Windows
    .venv/bin/python tools/make_mcp_fixture.py                # POSIX

Writes (only these two files, outside timeline-sync):

    ../timeline-mcp/test/fixtures/Timeline.synthetic.json
    ../timeline-mcp/test/fixtures/sync-status.synthetic.json

Deterministic: fixed seed, fixed end date and a fixed clock, all-fake places around lat 10.0 /
lng 20.0. The status file's ``output.current_export`` is rewritten to a neutral placeholder path
so the fixture contains no local paths; ``export_sha256`` still matches the fixture file.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from timeline_sync.config import Config  # noqa: E402
from timeline_sync.publish import sha256_file  # noqa: E402
from timeline_sync.sources import SyntheticSource  # noqa: E402
from timeline_sync.status import validate_status  # noqa: E402
from timeline_sync.sync import run_sync  # noqa: E402

FIXTURES = ROOT.parent / "timeline-mcp" / "test" / "fixtures"
NOW = datetime(2026, 9, 28, 9, 0, 0, tzinfo=timezone.utc)
END_DATE = date(2026, 9, 27)
PLACEHOLDER_PATH = "/synthetic/timeline/current/Timeline.json"


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="tlsync-fixture-") as tmp:
        cfg = Config(data_dir=Path(tmp) / "data", secrets_dir=Path(tmp) / "no-secrets", source="synthetic")
        src = SyntheticSource(cfg, seed=1, days=14, end_date=END_DATE, clock=lambda: NOW)
        outcome = run_sync(cfg, src, clock=lambda: NOW)
        if not outcome.ok:
            print("sync failed:", outcome.error, file=sys.stderr)
            return 1
        FIXTURES.mkdir(parents=True, exist_ok=True)
        dest = FIXTURES / "Timeline.synthetic.json"
        shutil.copyfile(cfg.current_export, dest)
        st = json.loads(cfg.status_file.read_text(encoding="utf-8"))
        st["sync_duration_seconds"] = 1.0
        st["output"]["current_export"] = PLACEHOLDER_PATH
        st["output"]["export_sha256"] = sha256_file(dest)
        problems = validate_status(st)
        if problems:
            print("invalid status:", problems, file=sys.stderr)
            return 1
        (FIXTURES / "sync-status.synthetic.json").write_text(json.dumps(st, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {dest} ({dest.stat().st_size} bytes) and sync-status.synthetic.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
