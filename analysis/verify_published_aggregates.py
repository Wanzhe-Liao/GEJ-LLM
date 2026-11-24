#!/usr/bin/env python3
"""Check aggregate tables against the figures reported in the revised manuscript."""

from __future__ import annotations

import csv
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKSPACE_RESULTS = HERE.parents[1] / "reports" / "analysis" / "results"
RESULTS = WORKSPACE_RESULTS if (WORKSPACE_RESULTS / "tables").is_dir() else (HERE / "published_aggregates")
TABLES = RESULTS / "tables"
PERM = RESULTS / "case_cluster_permutation_weighted_total.csv"
RECONSTRUCTED = RESULTS / "reconstructed_case_differences.csv"


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def close(actual: str, expected: float, tol: float = 1e-6) -> None:
    value = float(actual)
    if abs(value - expected) > tol:
        raise SystemExit(f"{actual} is not within {tol} of {expected}")


def main() -> None:
    primary = read_rows(TABLES / "table3_primary_weighted_total.csv")
    by_ds_contrast = {(row["dataset"], row["contrast"]): row for row in primary}
    close(by_ds_contrast[("all_rows", "peer - baseline")]["estimate"], 0.19628, 1e-4)
    close(by_ds_contrast[("all_rows", "peer - mcp")]["estimate"], 0.158346666666666, 1e-4)
    close(by_ds_contrast[("all_rows", "mcp - baseline")]["estimate"], 0.037933333333333, 1e-4)

    # Rater-quality and workbook-reconciliation sensitivity subsets (Supplementary Table S3)
    close(by_ds_contrast[("exclude_r4_qc_1800", "peer - baseline")]["estimate"], 0.2381, 1e-3)
    close(by_ds_contrast[("exclude_r4_qc_1800", "peer - mcp")]["estimate"], 0.1955, 1e-3)
    close(by_ds_contrast[("integer_raters_only", "peer - baseline")]["estimate"], 0.2569, 1e-3)
    close(by_ds_contrast[("integer_raters_only", "peer - mcp")]["estimate"], 0.2000, 1e-3)
    close(by_ds_contrast[("raw_unimputed_2248", "peer - baseline")]["estimate"], 0.1959, 1e-3)

    adjusted = read_rows(TABLES / "tableS14b_weighted_total_contrasts_workflow_feature_models.csv")
    full = [
        row
        for row in adjusted
        if row["model"] == "+ full workflow features" and row["contrast"] == "peer - baseline"
    ][0]
    close(full["estimate"], 0.04649883144355525, 1e-4)
    if float(full["lower_ci"]) >= 0 or float(full["upper_ci"]) <= 0:
        raise SystemExit("Fully adjusted RAG+CR versus TO interval should cross zero")

    length = read_rows(TABLES / "tableS11_surface_proxies_by_condition.csv")
    chars = {row["condition"]: float(row["mean_n_chars"]) for row in length}
    close(str(chars["baseline"]), 830.52, 0.05)
    close(str(chars["mcp"]), 1120.46, 0.05)
    close(str(chars["peer"]), 1496.39, 0.05)

    cites = read_rows(TABLES / "tableS6_citation_proxies_by_condition.csv")
    pct = {row["condition"]: float(row["pct_has_citation_section"]) for row in cites}
    close(str(pct["baseline"]), 0.0, 1e-9)
    close(str(pct["mcp"]), 62.0, 0.05)
    close(str(pct["peer"]), 56.7, 0.05)

    safety = read_rows(TABLES / "table5_decision_relevant_thresholds_by_condition.csv")
    counts = {row["condition_en"]: int(row["n_any_rater_safety_le2"]) for row in safety}
    if counts != {
        "Template-only": 79,
        "Guideline-RAG": 66,
        "RAG + Critique": 48,
    }:
        raise SystemExit(f"Unexpected safety numerators: {counts}")

    icc = read_rows(TABLES / "tableS24_icc_agreement_vs_consistency_overall.csv")
    safety_icc = [row for row in icc if row["endpoint"] == "safety"][0]
    close(safety_icc["icc2_1"], 0.116993668049811, 1e-4)

    calls = read_rows(TABLES / "tableS18_process_intensity_summary.csv")[0]
    if int(calls["llm_calls_peer_review"]) != 750 or int(calls["n_cases"]) != 10:
        raise SystemExit("Call-count table does not match the manuscript")

    signs = read_rows(PERM)
    peer = [row for row in signs if row["contrast"] == "peer - baseline"][0]
    close(peer["exact_p_two_sided"], 0.001953125, 1e-9)
    if int(peer["n_cases"]) != 10 or int(peer["n_assignments"]) != 1024:
        raise SystemExit("Sign-flip dimensions are not 10 cases and 1024 assignments")

    exact_by_contrast = {row["contrast"]: row for row in signs}
    close(exact_by_contrast["mcp - baseline"]["exact_p_two_sided"], 0.177734375, 1e-9)
    close(exact_by_contrast["peer - mcp"]["exact_p_two_sided"], 0.001953125, 1e-9)
    close(exact_by_contrast["mcp - baseline"]["max_abs_t_familywise_p"], 0.337890625, 1e-9)
    close(exact_by_contrast["peer - baseline"]["max_abs_t_familywise_p"], 0.001953125, 1e-9)
    close(exact_by_contrast["peer - mcp"]["max_abs_t_familywise_p"], 0.001953125, 1e-9)

    reconstructed = read_rows(RECONSTRUCTED)
    if len(reconstructed) != 10:
        raise SystemExit(f"Reconstructed case file should hold 10 cases; found {len(reconstructed)}")
    case_ids = [row["case_id"] for row in reconstructed]
    if sorted(case_ids) != sorted(f"C{index}" for index in range(1, 11)):
        raise SystemExit(f"Unexpected reconstructed case ids: {case_ids}")
    case_level = {
        row["contrast"]: row
        for row in read_rows(TABLES / "tableS16_case_level_contrasts_weighted_total.csv")
    }
    for column, contrast in (
        ("rag_minus_to", "mcp - baseline"),
        ("ragcr_minus_to", "peer - baseline"),
        ("ragcr_minus_rag", "peer - mcp"),
    ):
        values = [float(row[column]) for row in reconstructed]
        if len(values) != 10:
            raise SystemExit(f"Reconstructed column {column} does not hold 10 values")
        mean_value = sum(values) / len(values)
        sd_value = (
            sum((value - mean_value) ** 2 for value in values) / (len(values) - 1)
        ) ** 0.5
        if abs(mean_value - float(case_level[contrast]["mean"])) > 1e-8:
            raise SystemExit(
                f"Reconstructed mean for {contrast} {mean_value} does not match "
                f"Table S16 {case_level[contrast]['mean']}"
            )
        if abs(sd_value - float(case_level[contrast]["sd"])) > 1e-8:
            raise SystemExit(
                f"Reconstructed SD for {contrast} {sd_value} does not match "
                f"Table S16 {case_level[contrast]['sd']}"
            )

    qc = read_rows(TABLES / "table1_overall_counts.csv")[0]
    if int(qc["n_needs_review_rows"]) != 0 or int(qc["n_rating_rows"]) != 2250:
        raise SystemExit("Rating-row QC counts do not match the manuscript")
    qc_by_condition = {
        row["condition_en"]: (int(row["n_rating_rows"]), int(row["n_needs_review_rows"]))
        for row in read_rows(TABLES / "tableS29_qc_flag_distribution_by_condition.csv")
        if row["condition_en"] != "All conditions"
    }
    if qc_by_condition != {
        "Template-only": (750, 0),
        "Guideline-RAG": (750, 0),
        "RAG + Critique": (750, 0),
    }:
        raise SystemExit(f"Unexpected QC counts by condition: {qc_by_condition}")

    call_counts = read_rows(TABLES / "tableS18_process_intensity_summary.csv")[0]
    workflow_calls = {
        "Template-only": int(call_counts["llm_calls_baseline"]),
        "Guideline-RAG": int(call_counts["llm_calls_mcp_query"])
        + int(call_counts["llm_calls_mcp_optimize"]),
        "RAG + Critique": int(call_counts["llm_calls_peer_review"])
        + int(call_counts["llm_calls_peer_refine"]),
    }
    if workflow_calls != {
        "Template-only": 150,
        "Guideline-RAG": 300,
        "RAG + Critique": 900,
    }:
        raise SystemExit(f"Unexpected per-workflow call counts: {workflow_calls}")
    if int(call_counts["llm_calls_total"]) != 1350:
        raise SystemExit("Total call count is not 1350")

    safety_reweight = read_rows(TABLES / "tableS34_safety_reweighting_arithmetic_sensitivity.csv")
    emphasised = {
        row["contrast"]: float(row["arithmetic_reweighted_estimate"])
        for row in safety_reweight
        if row["weight_scheme"] == "safety-emphasis translation"
    }
    close(str(emphasised["RAG+CR vs template"]), 0.1961, 1e-4)
    close(str(emphasised["RAG+CR vs RAG"]), 0.1583, 1e-4)

    models = read_rows(TABLES / "tableS4_weighted_total_contrasts_by_model_variant.csv")
    variants = sorted({row["model_cluster"] for row in models})
    if variants != ["gemini-3-pro", "gpt-5", "grok-4", "kimi-k2-thinking", "qwen3-max"]:
        raise SystemExit(f"Unexpected model variants in Table S4/S5: {variants}")

    print(f"Aggregate tables in {RESULTS} match the revised manuscript figures.")


if __name__ == "__main__":
    main()
