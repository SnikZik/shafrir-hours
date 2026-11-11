#!/usr/bin/env python3
"""Builds dist/Code.gs: real key and sheet id, Hebrew as \\u escapes so pasting into the editor can't garble it."""
import collections
import json
import pathlib
import sys

root = pathlib.Path(__file__).parent
sheet_id = sys.argv[1]
source = (root / "apps-script" / "Code.gs").read_text(encoding="utf-8")
source = source.replace("__SHEET_ID__", sheet_id).replace("__KEY__", (root / ".secret").read_text().strip())
source = source.replace("__MANAGER_EMAIL__", (root / ".manager_email").read_text().strip())
source = source.replace("__REMIND_EMAILS__", (root / ".remind_emails").read_text().strip())
source = source.replace("__REPORT_EMAILS__", (root / ".report_emails").read_text().strip())
messages = (root / "messages.local.json").read_text(encoding="utf-8")
lines = [line for group in json.loads(messages).values() for line in group]
repeats = [line for line, count in collections.Counter(lines).items() if count > 1]
if repeats or "—" in messages or "–" in messages:
    sys.exit(f"bad messages: repeats={repeats} or dashes present")
source = source.replace("/*__MESSAGES__*/ {}", messages.strip())
escaped = "".join(c if ord(c) < 128 else "\\u%04x" % ord(c) for c in source)
(root / "dist").mkdir(exist_ok=True)
(root / "dist" / "Code.gs").write_text(escaped, encoding="ascii")
print(root / "dist" / "Code.gs", len(escaped))
