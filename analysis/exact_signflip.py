from __future__ import annotations

import csv
import itertools
import math
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "reports" / "analysis" / "results"
TABLES = RESULTS / "tables"
OUT = RESULTS / "case_cluster_permutation_weighted_total.csv"
CONTRAST_ORDER = ["mcp - baseline", "peer - baseline", "peer - mcp"]


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def mean(values: list[float]) -> float:
    return sum(values) / len(values)


def sample_sd(values: list[float]) -> float:
    mu = mean(values)
    return math.sqrt(sum((value - mu) ** 2 for value in values) / (len(values) - 1))


def t_stat(values: list[float]) -> float:
    sd = sample_sd(values)
    return mean(values) / (sd / math.sqrt(len(values)))


def p_value(count: int, total: int) -> float:
    return count / total


def main() -> int:
    case_summary = {
        row["contrast"]: row
        for row in read_csv(TABLES / "tableS16_case_level_contrasts_weighted_total.csv")
    }
    loo_rows = [
        row
        for row in read_csv(TABLES / "tableS2_robustness_leave_one_out_weighted_total.csv")
        if row.get("leave_out_type") == "case_pseudo" and row.get("contrast") in CONTRAST_ORDER
    ]
    cases = sorted({row["leave_out"] for row in loo_rows})
    if len(cases) != 10:
        raise RuntimeError(f"Expected 10 leave-one-case rows per contrast; found cases={cases}")

    case_diffs: dict[str, list[float]] = {}
    observed: dict[str, dict[str, float]] = {}
    for contrast in CONTRAST_ORDER:
        full_mean = float(case_summary[contrast]["mean"])
        rows = [row for row in loo_rows if row["contrast"] == contrast]
        if len(rows) != 10:
            raise RuntimeError(f"Expected 10 leave-one-case rows for {contrast}; found {len(rows)}")
        diffs = []
        for row in sorted(rows, key=lambda item: item["leave_out"]):
            # For a 10-case mean M and leave-one-case mean M(-i), the omitted
            # case-level paired difference is 10*M - 9*M(-i). These estimates
            # are valid here because Table S2's leave-one-case rows reproduce
            # the Table S16 case-level mean and sample SD exactly.
            diffs.append(10 * full_mean - 9 * float(row["estimate"]))
        recovered_mean = mean(diffs)
        recovered_sd = sample_sd(diffs)
        expected_sd = float(case_summary[contrast]["sd"])
        if not math.isclose(recovered_mean, full_mean, rel_tol=0, abs_tol=1e-10):
            raise RuntimeError(f"Recovered mean mismatch for {contrast}: {recovered_mean} vs {full_mean}")
        if not math.isclose(recovered_sd, expected_sd, rel_tol=0, abs_tol=1e-10):
            raise RuntimeError(f"Recovered SD mismatch for {contrast}: {recovered_sd} vs {expected_sd}")
        case_diffs[contrast] = diffs
        observed[contrast] = {
            "mean": full_mean,
            "t": t_stat(diffs),
            "sd": recovered_sd,
        }

    assignments = list(itertools.product((-1, 1), repeat=len(cases)))
    perm_t_by_contrast = {contrast: [] for contrast in CONTRAST_ORDER}
    max_abs_t_values: list[float] = []
    for signs in assignments:
        assignment_abs_t = []
        for contrast in CONTRAST_ORDER:
            signed = [value * sign for value, sign in zip(case_diffs[contrast], signs)]
            current_t = t_stat(signed)
            perm_t_by_contrast[contrast].append(current_t)
            assignment_abs_t.append(abs(current_t))
        max_abs_t_values.append(max(assignment_abs_t))

    rows: list[dict[str, object]] = []
    for contrast in CONTRAST_ORDER:
        obs_abs_t = abs(observed[contrast]["t"])
        exact_count = sum(abs(value) >= obs_abs_t - 1e-12 for value in perm_t_by_contrast[contrast])
        family_count = sum(value >= obs_abs_t - 1e-12 for value in max_abs_t_values)
        rows.append(
            {
                "contrast": contrast,
                "observed_case_mean_difference": observed[contrast]["mean"],
                "observed_case_sd_difference": observed[contrast]["sd"],
                "observed_t": observed[contrast]["t"],
                "n_cases": len(cases),
                "n_assignments": len(assignments),
                "exact_p_two_sided": p_value(exact_count, len(assignments)),
                "max_abs_t_familywise_p": p_value(family_count, len(assignments)),
                "n_permutations_completed": len(assignments),
                "permutation_p_two_sided": p_value(exact_count, len(assignments)),
                "inference": "exact complete sign-flip enumeration over reconstructed case-level paired differences",
            }
        )

    write_csv(OUT, rows)
    print(OUT)
    for row in rows:
        print(
            row["contrast"],
            f"exact_p={row['exact_p_two_sided']:.6f}",
            f"max_abs_t_fwer_p={row['max_abs_t_familywise_p']:.6f}",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
