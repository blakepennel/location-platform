import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from timeline_sync.config import Config  # noqa: E402

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schemas" / "sync-status.schema.json"


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for k in ("TIMELINE_DATA_DIR", "TIMELINE_SECRETS_DIR", "TIMELINE_SOURCE", "TIMELINE_LOCAL_DB",
              "TIMELINE_KEEP_EXPORTS", "TIMELINE_DEFAULT_UTC_OFFSET_MIN", "CHROME_PATH"):
        monkeypatch.delenv(k, raising=False)


@pytest.fixture
def cfg(tmp_path):
    return Config(data_dir=tmp_path / "data", secrets_dir=tmp_path / "secrets")


@pytest.fixture(scope="session")
def status_schema():
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


@pytest.fixture
def validate_status_schema(status_schema):
    import jsonschema

    def _v(doc):
        jsonschema.Draft202012Validator(status_schema).validate(doc)
    return _v
