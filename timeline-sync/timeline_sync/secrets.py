"""Secure handling of the few secrets this tool owns.

* ``master.txt``   Google master token (long-lived credential, treat like a password)
* ``key.b64``      base64 of the 32-byte Timeline (security domain) AES key
* ``android_id``   16-hex id the tokens bind to (not secret per se, but must persist)
* ``account.json`` {"email": ...} only

Rules enforced here: files are created private from the start (POSIX 0600/0700; Windows ACL
reduced to the current user with ``icacls /inheritance:r /grant:r``), written atomically, and
read helpers return values without ever logging them. Nothing here prints a secret.

NOTE: the file name ``secrets.py`` is deliberate (it is requested by the project layout); it
shadows nothing because the package is imported as ``timeline_sync.secrets``. The stdlib
``secrets`` module is never imported from inside this package under that bare name.
"""
from __future__ import annotations

import getpass
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Optional

from .config import Config
from .logging import log

IS_WINDOWS = os.name == "nt"


class Secret:
    """Wraps a secret string so accidental print/repr/f-string/log cannot leak it."""

    __slots__ = ("_v",)

    def __init__(self, value: str):
        self._v = value

    def reveal(self) -> str:
        return self._v

    def __len__(self) -> int:
        return len(self._v)

    def __repr__(self) -> str:
        return f"<Secret len={len(self._v)}>"

    __str__ = __repr__

    def __format__(self, spec: str) -> str:
        return repr(self)


# ---------------------------------------------------------------- permissions
def _win_user() -> str:
    return os.environ.get("USERNAME") or getpass.getuser()


def _icacls_lock(path: Path, is_dir: bool) -> bool:
    grant = f"{_win_user()}:(OI)(CI)F" if is_dir else f"{_win_user()}:F"
    try:
        # /reset drops any stray explicit ACEs (e.g. Everyone) first; then, as specified,
        # remove inheritance and grant the current user alone.
        subprocess.run(["icacls", str(path), "/reset"], capture_output=True, text=True, timeout=30)
        p = subprocess.run(["icacls", str(path), "/inheritance:r", "/grant:r", grant],
                           capture_output=True, text=True, timeout=30)
        return p.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def secure_dir(path: Path) -> bool:
    """Restrict an existing directory to the current user. Returns success."""
    if IS_WINDOWS:
        ok = _icacls_lock(path, True)
    else:
        try:
            os.chmod(path, 0o700)
            ok = True
        except OSError:
            ok = False
    if not ok:
        log.warning("secrets.perms_failed", kind="dir")
    return ok


def secure_file(path: Path) -> bool:
    if IS_WINDOWS:
        ok = _icacls_lock(path, False)
    else:
        try:
            os.chmod(path, 0o600)
            ok = True
        except OSError:
            ok = False
    if not ok:
        log.warning("secrets.perms_failed", kind="file")
    return ok


def secure_mkdir(path: Path) -> Path:
    """Create ``path`` (and parents) and lock the leaf directory to the current user."""
    path = Path(path)
    missing = []
    p = path
    while not p.exists() and p != p.parent:
        missing.append(p)
        p = p.parent
    path.mkdir(parents=True, exist_ok=True)
    if IS_WINDOWS:
        secure_dir(path)
    else:
        for d in missing:  # only directories we created ourselves
            secure_dir(d)
    return path


def check_perms(path: Path) -> Optional[bool]:
    """True = private to the current user, False = readable by others, None = unknown/missing."""
    path = Path(path)
    if not path.exists():
        return None
    if not IS_WINDOWS:
        return (path.stat().st_mode & 0o077) == 0
    try:
        p = subprocess.run(["icacls", str(path)], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    if p.returncode != 0:
        return None
    out = p.stdout.lower()
    for bad in ("everyone:", "\\users:", "authenticated users:", "\\guests:"):
        if bad in out:
            return False
    return True


# ---------------------------------------------------------------- read / write
def _replace_with_retry(src: Path, dst: Path, attempts: int = 8) -> None:
    for i in range(attempts):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(0.05 * (i + 1))


def write_secret(path: Path, value: str) -> int:
    """Atomically write ``value`` to ``path`` with private permissions. Returns len(value)."""
    path = Path(path)
    secure_mkdir(path.parent)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0)
    fd = os.open(tmp, flags, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(value.encode("utf-8"))
            f.flush()
            os.fsync(f.fileno())
        secure_file(tmp)
        _replace_with_retry(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    return len(value)


def read_secret(path: Path) -> Optional[str]:
    """Return the stripped file content, or None if missing/empty. Never logs the value."""
    try:
        v = Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return v or None


def secret_present(path: Path) -> bool:
    return read_secret(path) is not None


def secret_presence(cfg: Config) -> dict:
    return {
        "master_token": secret_present(cfg.master_file),
        "key": secret_present(cfg.key_file),
        "android_id": secret_present(cfg.android_id_file),
        "account": secret_present(cfg.account_file),
    }


def write_account_email(cfg: Config, email: str) -> None:
    write_secret(cfg.account_file, json.dumps({"email": email}))


def read_account_email(cfg: Config) -> Optional[str]:
    raw = read_secret(cfg.account_file)
    if not raw:
        return None
    try:
        email = json.loads(raw).get("email")
    except (ValueError, AttributeError):
        return None
    return email if isinstance(email, str) and email else None
