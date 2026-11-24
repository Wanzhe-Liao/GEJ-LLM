#!/usr/bin/env python3
"""Check a human rating file supplied by the authors.

This script does not read model critique scores and does not invent rows.
If the rating file is absent, it exits with status 2.
"""

from __future__ import annotations

import argparse
import csv
import sys
from collections import Counter
from pathlib import Path

REQUIRED = (
    "rater_id",
    "report_id",
    "accuracy",
    "completeness",
    "safety",
    "clarity",
)
EXPECTED_RATERS = {"R1", "R2", "R3", "R4", "R5"}


def fail(message: str, code: int = 1) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "scores",
        nargs="?",
        default="",
        help="Path to the row-level human rating CSV",
    )
    args = parser.parse_args()
    if not args.scores:
        fail(
            "No rating file was provided. "
            "Model critique scores from runPeerReview are not a substitute.",
            2,
        )
    path = Path(args.scores)
    if not path.is_file():
        fail(
            f"Rating file not found: {path}. "
            "This audit does not substitute model-generated peer-review scores.",
            2,
        )

    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            fail("The rating file has no header.")
        missing = [name for name in REQUIRED if name not in reader.fieldnames]
        if missing:
            fail("Missing columns: " + ", ".join(missing))
        rows = list(reader)

    if len(rows) != 2250:
        fail(f"Expected 2250 rows, found {len(rows)}.")

    raters = Counter((row.get("rater_id") or "").strip() for row in rows)
    reports = {(row.get("report_id") or "").strip() for row in rows}
    if set(raters) != EXPECTED_RATERS:
        fail(f"Rater labels were {sorted(raters)}, expected R1-R5.")
    if any(raters[label] != 450 for label in EXPECTED_RATERS):
        fail(f"Each rater should have 450 rows. Counts: {dict(raters)}.")
    if len(reports) != 450 or "" in reports:
        fail(f"Expected 450 report identifiers, found {len(reports) - (1 if '' in reports else 0)}.")

    for row in rows:
        for name in ("accuracy", "completeness", "safety", "clarity"):
            raw = (row.get(name) or "").strip()
            if raw == "":
                fail(f"Empty {name} for report {row.get('report_id')} rater {row.get('rater_id')}.")
            try:
                value = float(raw)
            except ValueError:
                fail(f"Non-numeric {name}: {raw!r}")
            if value < 1 or value > 5:
                fail(f"{name} outside 1-5: {value}")

    print(
        "Rating file matches the study shell: "
        "2250 rows, 450 reports, raters R1-R5, domain scores present. "
        "This check does not reveal which rater label belongs to which clinician."
    )


if __name__ == "__main__":
    main()
