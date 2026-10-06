# SPDX-License-Identifier: AGPL-3.0-only
"""pytest bootstrap: service dir on sys.path, tests import top-level modules."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
