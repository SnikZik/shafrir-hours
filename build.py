#!/usr/bin/env python3
"""Builds dist/Code.gs: real keys, sheet id and addresses, Hebrew as \\u escapes so pasting into the editor can't garble it."""
import pathlib
import sys

root = pathlib.Path(__file__).parent
sheet_id = sys.argv[1]
source = (root / "apps-script" / "Code.gs").read_text(encoding="utf-8")
values = {
    "__SHEET_ID__": sheet_id,
    "__KEY__": (root / ".secret").read_text().strip(),
    "__MANAGER_KEY__": (root / ".manager_key").read_text().strip(),
    "__REMIND_EMAILS__": (root / ".remind_emails").read_text().strip(),
    "__REPORT_EMAILS__": (root / ".report_emails").read_text().strip(),
    "__THREAD_EMAILS__": (root / ".thread_emails").read_text().strip(),
}
for placeholder, value in values.items():
    if placeholder not in source:
        sys.exit(f"missing placeholder {placeholder}")
    source = source.replace(placeholder, value)
if "—" in source or "–" in source:
    sys.exit("dashes present")
escaped = "".join(c if ord(c) < 128 else "\\u%04x" % ord(c) for c in source)
(root / "dist").mkdir(exist_ok=True)
(root / "dist" / "Code.gs").write_text(escaped, encoding="ascii")
print(root / "dist" / "Code.gs", len(escaped))
