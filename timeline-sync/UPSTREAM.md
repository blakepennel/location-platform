# Upstream strategy: pinned submodule + runtime shims

`timeline-sync` is a thin wrapper around [arkenoi/timeline-export](https://github.com/arkenoi/timeline-export),
included as the git submodule `timeline-sync/upstream/`, **pinned at commit `3c1faa0`**.

**Rule: no file inside `upstream/` is ever modified** (a test asserts `git status` there is clean).
Upstream scripts are loaded by file path with `importlib` (`timeline_sync/upstream.py`); where they
are not import-friendly or not Windows-friendly we patch the *loaded in-memory module* and record
the shim below. `timeline-sync doctor` verifies that every anchor a shim relies on still exists.

## Shims applied

| # | Upstream | Problem | Shim (in) | If upstream changes |
|---|---|---|---|---|
| 1 | `web_key.py` | hardcodes `drv = "/tmp/.web_key_driver.js"` (breaks on Windows); default `--chrome /usr/bin/chromium-browser` | Source text is read, the quoted literal is asserted to occur **exactly once** and replaced with a private tempfile path, then compiled and exec'd as `__main__` with `sys.argv` set (`upstream.run_web_key`). stderr is redacted line by line and the `final url` line hidden. We always pass `--chrome` (auto-detected Chrome/Edge) and `--node-path upstream/node_modules`. | Raises `UpstreamError` (fails loudly) |
| 2 | `build_records.py` | `strftime('%-d')` raises `ValueError` on Windows; `open()` uses the locale encoding (mojibake `Â°` on cp1252) | `daterange` replaced by a portable equivalent using `.day`; module-level `open` defaults text mode to UTF-8 (`upstream.build_records`). Idempotent. | Raises `UpstreamError` if `daterange`/`dt`/`build` vanish |
| 3 | `odlh_export.py` | `build()` drops `segment_id` for non-trip segments; leaks its sqlite handle (pins the file on Windows) | Only the row loop (~30 lines) is reimplemented in `export.py`; every decoder (`fields`, `first`, `submsg`, `ts_of`, `iso`, `to_signed`, `dec_visit`, `dec_activity`, `dec_path`, `dec_trip`) is upstream's. A test asserts our output equals upstream `build()` minus `segmentId`/`segmentType`. Differences: rows ordered by `start, rowid` (deterministic ties); seed offset configurable via `TIMELINE_DEFAULT_UTC_OFFSET_MIN`. | Parity test fails |
| 4 | `geller_fetch.py` | `main()` is a CLI (token/key as files/args, prints to stderr, writes the DB itself) | Its functions (`build_request`, `grpc_frame`, `grpc_unframe`, `parse`, `one`, `snapshots`, `rows_of`, `sync_token_of`, `write_db`, `decrypt`) are called directly from `sources.py`, re-orchestrating `main()` so the bearer stays in memory, `max(timestamp_millis)` and the sync token are captured before `write_db`, and upstream stderr warnings are captured/redacted/logged. HTTP is done by us (httpx, injectable transport for tests). | `doctor` API check |
| 5 | `get_token.py` | none needed | `SCOPE/APP/CLIENT_SIG`, `resolve_android_id(path=...)`, `oauth_token_from_browser` are used as-is | `doctor` API check |

Not wired into the default sync (optional, untouched): `resolve_names.js`, `place_names.py`,
`get_consent_cookie.sh`, `travel_mode.py`, `extract_key.py`, and the whole container path.

## One-time setup notes

* `puppeteer-core` (needed only for `timeline-sync key`) lives in `upstream/node_modules`, which is
  git-ignored upstream. Install it without touching upstream's lockfile:
  `npm ci --prefix timeline-sync/upstream`.
* `timeline-sync/.gitignore` un-ignores `timeline_sync/secrets.py` (source code only) because the
  repo-root `.gitignore` has a blanket `*secret*` rule.

## Bumping the pin

```bash
git -C timeline-sync/upstream fetch
git -C timeline-sync/upstream checkout <sha>
cd timeline-sync && .venv/Scripts/python -m pytest      # POSIX: .venv/bin/python
.venv/Scripts/timeline-sync doctor                       # shim anchors + pin status
```

Then update `PINNED_COMMIT` in `timeline_sync/upstream.py`, note behavioural changes here, and
commit the submodule pointer. If a shim anchor changed, the tests/doctor fail loudly instead of
silently mis-patching. Things to eyeball in the diff: the Geller request/response field numbers,
`web_key.py` driver handling, `odlh_export.build()` (mirror any change into `export.py`),
`build_records.py` `open`/`strftime` usage.

## Brittleness discovered while wrapping upstream (3c1faa0)

* `rows_of()` decodes ExternalDbSnapshot field 4 entries **directly as strings** (repeated string,
  not a message with the name in field 1). Our synthetic encoder follows the code, not the
  assumption.
* `snapshots()` prints upstream warnings to stderr (`server returned an error result`); we capture
  and redact those.
* gRPC trailers: upstream reads `grpc-status` from response *headers* and defaults to `"0"`; an
  error delivered only as HTTP/2 trailers (httpx does not expose trailers) could look like
  success. Empty/undecodable bodies are still caught (empty frame -> error) and an empty result set
  fails validation, so a bad response never replaces last-known-good.
* `geller_fetch.decrypt()` raises a bare `RuntimeError` for a wrong key; we classify that as the
  `decrypt` stage.
* `web_key.py` passes the self-signing-in URL on the `node` command line and prints a truncated
  final URL; it also writes its Node driver to a fixed `/tmp` path (shimmed).
* `odlh_export.build()` opens sqlite without closing; `build_records` and `odlh_export.__main__`
  write text with the locale encoding.
* `write_db()` always rebuilds from scratch (BatchSync with no token is a full snapshot), so a
  short/partial response is indistinguishable from a real shrink; hence our >50% shrink guard.
