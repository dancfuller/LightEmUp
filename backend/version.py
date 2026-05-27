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

__version__ = "0.3.0"


def _git_hash() -> str:
    """Short HEAD hash of the repo this file lives in. Empty on failure."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=Path(__file__).parent.parent,
            capture_output=True, text=True, timeout=2,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return ""


# Cache at import time — we don't want a subprocess on every request.
GIT_HASH = _git_hash()


def version_string() -> str:
    if GIT_HASH:
        return f"v{__version__} ({GIT_HASH})"
    return f"v{__version__}"
