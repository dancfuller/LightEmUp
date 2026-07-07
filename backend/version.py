"""Single source of truth for the LightEmUp version.

Semantic versioning X.Y.Z:
  X major  - breaking config schema changes, removed/renamed endpoints,
             fundamental UX reworks.
  Y minor  - meaningful user-visible features or capabilities.
  Z patch  - bug fixes, small UI refinements, internal cleanup.

The /api/version endpoint surfaces this plus the short git hash so the
deployed Pi's actual build is easy to confirm from the browser.
"""

import subprocess
from pathlib import Path

__version__ = "3.4.0"


def _git(args: list[str]) -> str:
    """Run a git command in the repo root, return stripped stdout or empty."""
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=Path(__file__).parent.parent,
            capture_output=True, text=True, timeout=2,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return ""


# Cache at import time — we don't want a subprocess on every request.
GIT_HASH = _git(["rev-parse", "--short", "HEAD"])
# %cs = committer date in ISO short form (YYYY-MM-DD).
GIT_DATE = _git(["log", "-1", "--format=%cs", "HEAD"])


def version_string() -> str:
    parts = [f"v{__version__}"]
    extras = []
    if GIT_HASH:
        extras.append(GIT_HASH)
    if GIT_DATE:
        extras.append(GIT_DATE)
    if extras:
        parts.append(f"({' · '.join(extras)})")
    return " ".join(parts)
