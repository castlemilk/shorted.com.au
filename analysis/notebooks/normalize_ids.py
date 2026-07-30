#!/usr/bin/env python3
"""Give every cell in a notebook an `id`.

WHY THIS EXISTS: nbformat 4.5 made `id` REQUIRED on every cell. A notebook that
declares `nbformat_minor >= 5` without ids is invalid, and JupyterLab returns a
bare "internal server error" (HTTP 500) when it tries to save one — with nothing
in the UI to say what is wrong. Older nbformat versions repaired it silently on
read, which is why such a notebook can execute fine under nbconvert and still
break the moment you open it in Lab.

Deliberately stdlib-only. `nbformat` lives in whichever interpreter runs Jupyter,
which is often NOT the `python3` on PATH — a repair tool that cannot run on a
broken machine is no use.
"""

import json
import sys
import uuid
from pathlib import Path


def normalize(path: Path) -> int:
    """Assign an id to every cell that lacks one. Returns the number added."""
    notebook = json.loads(path.read_text())
    added = 0
    for cell in notebook.get("cells", []):
        if not cell.get("id"):
            # Must match ^[a-zA-Z0-9-_]+$ and be 1-64 chars.
            cell["id"] = uuid.uuid4().hex[:12]
            added += 1
    if added:
        # indent=1 matches what Jupyter itself writes, so a later save by Lab
        # produces a small diff rather than reformatting the whole file.
        path.write_text(json.dumps(notebook, indent=1) + "\n")
    return added


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} <notebook.ipynb>", file=sys.stderr)
        return 2
    path = Path(argv[1])
    if not path.exists():
        print(f"no such notebook: {path}", file=sys.stderr)
        return 1
    added = normalize(path)
    total = len(json.loads(path.read_text()).get("cells", []))
    print(f"  {added} id(s) added; {total} cells now valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
