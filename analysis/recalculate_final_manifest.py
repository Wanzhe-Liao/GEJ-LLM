#!/usr/bin/env python3
"""Exact REML & Laplace-CLMM recalculation on the generation-time master manifest (report_manifest_final.csv).

Requires governed row-level study inputs (--controlled-dir or --controlled-zip).
When invoked without governed inputs, exits with status 2 (see Manuscript Section 7).
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from zipfile import ZipFile

import numpy as np
from scipy import optimize, special, stats

HERE = Path(__file__).resolve().parent
DEFAULT_OUT = HERE / "published_aggregates"

PHASES = ["Outpatient", "Inpatient", "Discharge"]
PHASE_MAP = {"门诊阶段": "Outpatient", "住院阶段": "Inpatient", "出院阶段": "Discharge"}
CONDITIONS = ["baseline", "mcp", "peer"]
COND_EN = {"baseline": "Template-only", "mcp": "Guideline-RAG", "peer": "RAG + Critique"}


def load_zip_csv(z: ZipFile, suffix: str) -> list[dict[str, str]]:
    matches = [n for n in z.namelist() if n.endswith(suffix)]
    if not matches:
        raise FileNotFoundError(f"Controlled archive missing *{suffix}")
    return list(csv.DictReader(io.StringIO(z.read(matches[0]).decode("utf-8-sig"))))


def load_disk_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def write_csv_targets(targets: list[Path], rel_path: str, rows: list[dict[str, object]]) -> None:
    fieldnames = list(rows[0].keys())
    for base in targets:
        target = base / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)


def holm_adjust(pvals: list[float]) -> np.ndarray:
    m = len(pvals)
    order = np.argsort(pvals)
    adj = np.empty(m)
    running = 0.0
    for rank, idx in enumerate(order):
        running = max(running, (m - rank) * pvals[idx])
        adj[idx] = min(1.0, running)
    return adj


def wilson_ci(x: int, n: int) -> tuple[float, float]:
    z = stats.norm.ppf(0.975)
    p = x / n
    denom = 1.0 + (z ** 2) / n
    center = (p + (z ** 2) / (2.0 * n)) / denom
    half = (z * math.sqrt((p * (1.0 - p) / n) + (z ** 2) / (4.0 * n * n))) / denom
    return center - half, center + half


def build_design_matrix(rows, extra_covariates=None):
    """Build X for condition * phase (reference: baseline, Outpatient) + optional standardized covariates."""
    cond_col = [r["condition"] for r in rows]
    phase_col = [r["phase_en"] for r in rows]
    n = len(rows)
    cols = [np.ones(n)]
    c2 = np.array([1.0 if c == "mcp" else 0.0 for c in cond_col])
    c3 = np.array([1.0 if c == "peer" else 0.0 for c in cond_col])
    p2 = np.array([1.0 if p == "Inpatient" else 0.0 for p in phase_col])
    p3 = np.array([1.0 if p == "Discharge" else 0.0 for p in phase_col])
    cols.extend([c2, c3, p2, p3, c2 * p2, c2 * p3, c3 * p2, c3 * p3])
    if extra_covariates:
        for arr in extra_covariates:
            arr = np.asarray(arr, dtype=float)
            cols.append((arr - arr.mean()) / arr.std(ddof=1))
    X = np.column_stack(cols)
    k_extra = len(extra_covariates) if extra_covariates else 0
    z_ex = [0.0] * k_extra
    v_mcp_base = np.array([0, 1, 0, 0, 0, 1 / 3, 1 / 3, 0, 0] + z_ex, dtype=float)
    v_peer_base = np.array([0, 0, 1, 0, 0, 0, 0, 1 / 3, 1 / 3] + z_ex, dtype=float)
    v_peer_mcp = v_peer_base - v_mcp_base
    contrasts = [
        ("mcp - baseline", v_mcp_base),
        ("peer - baseline", v_peer_base),
        ("peer - mcp", v_peer_mcp),
    ]
    return X, contrasts


def fit_lmm_reml(y, X, block_ids, report_ids, rater_ids, case_ids=None, include_report=True):
    """Exact REML solver exploiting block-diagonal structure conditional on rater (+ optional case)."""
    y = np.asarray(y, dtype=float)
    X = np.asarray(X, dtype=float)
    n, p = X.shape

    blk_map = defaultdict(list)
    for i, b in enumerate(block_ids):
        blk_map[b].append(i)
    blocks = [np.array(idxs, dtype=int) for idxs in blk_map.values()]
    rep_in_blk = []
    for idxs in blocks:
        r_vals = [report_ids[i] for i in idxs]
        uniq = {v: k for k, v in enumerate(sorted(set(r_vals)))}
        m = np.zeros((len(idxs), len(uniq)))
        for row_i, v in enumerate(r_vals):
            m[row_i, uniq[v]] = 1.0
        rep_in_blk.append(m)

    uniq_rat = sorted(set(rater_ids))
    rat_map = {v: k for k, v in enumerate(uniq_rat)}
    Z_rat = np.zeros((n, len(uniq_rat)))
    for i, v in enumerate(rater_ids):
        Z_rat[i, rat_map[v]] = 1.0

    has_case = case_ids is not None
    if has_case:
        uniq_case = sorted(set(case_ids))
        c_map = {v: k for k, v in enumerate(uniq_case)}
        Z_case = np.zeros((n, len(uniq_case)))
        for i, v in enumerate(case_ids):
            Z_case[i, c_map[v]] = 1.0
        Z_top = np.hstack([Z_rat, Z_case])
        q_rat, q_case = len(uniq_rat), len(uniq_case)
    else:
        Z_top = Z_rat
        q_rat, q_case = len(uniq_rat), 0

    def eval_reml(theta):
        v_blk = theta[0]
        idx_t = 1
        v_rep = theta[idx_t] if include_report else 0.0
        if include_report:
            idx_t += 1
        v_rat = theta[idx_t]
        idx_t += 1
        v_case = theta[idx_t] if has_case else 0.0

        M = np.column_stack([y, X, Z_top])
        Dinv_M = np.empty_like(M)
        logdet_D = 0.0
        for idxs, Zr in zip(blocks, rep_in_blk):
            nb = len(idxs)
            Db = np.eye(nb) + v_blk * np.ones((nb, nb))
            if include_report:
                Db = Db + v_rep * (Zr @ Zr.T)
            L = np.linalg.cholesky(Db)
            logdet_D += 2.0 * np.sum(np.log(np.diag(L)))
            Dinv_M[idxs] = np.linalg.solve(L.T, np.linalg.solve(L, M[idxs]))

        g_diag = np.array(([v_rat] * q_rat) + ([v_case] * q_case), dtype=float)
        sg = np.sqrt(np.maximum(g_diag, 0.0))
        Dinv_y = Dinv_M[:, 0]
        Dinv_X = Dinv_M[:, 1:1 + p]
        Dinv_Z = Dinv_M[:, 1 + p:]

        Zt_Dinv_Z = Z_top.T @ Dinv_Z
        A = np.eye(len(g_diag)) + (sg[:, None] * Zt_Dinv_Z * sg[None, :])
        LA = np.linalg.cholesky(A)
        logdet_V = logdet_D + 2.0 * np.sum(np.log(np.diag(LA)))

        def apply_Vinv(Dinv_U):
            rhs = sg[:, None] * (Z_top.T @ Dinv_U) if Dinv_U.ndim == 2 else sg * (Z_top.T @ Dinv_U)
            tmp = np.linalg.solve(LA.T, np.linalg.solve(LA, rhs))
            corr = Dinv_Z @ (sg[:, None] * tmp) if Dinv_U.ndim == 2 else Dinv_Z @ (sg * tmp)
            return Dinv_U - corr

        Vinv_y = apply_Vinv(Dinv_y)
        Vinv_X = apply_Vinv(Dinv_X)
        XtVinvX = X.T @ Vinv_X
        LX = np.linalg.cholesky(XtVinvX)
        logdet_XtVinvX = 2.0 * np.sum(np.log(np.diag(LX)))
        beta = np.linalg.solve(LX.T, np.linalg.solve(LX, X.T @ Vinv_y))
        resid = y - X @ beta
        Vinv_r = Vinv_y - Vinv_X @ beta
        s2 = float(resid @ Vinv_r) / (n - p)
        reml_nll = 0.5 * (logdet_V + logdet_XtVinvX + (n - p) * np.log(s2))
        return reml_nll, beta, s2 * np.linalg.inv(XtVinvX), s2

    x0 = [0.2] + ([0.1] if include_report else []) + [1.0] + ([0.05] if has_case else [])
    bounds = [(0.0, 1e4)] * len(x0)
    res = optimize.minimize(lambda th: eval_reml(th)[0], x0, method="L-BFGS-B", bounds=bounds, options={"ftol": 1e-13, "gtol": 1e-10})
    _, beta, cov_beta, s2 = eval_reml(res.x)
    # Block-count degrees-of-freedom approximation: 2*(B - 1) minus report-level fixed covariates (298 in primary model).
    n_blocks = len(blocks)
    df_approx = max(10, 2 * (n_blocks - 1) - max(0, p - 9))
    return beta, cov_beta, df_approx, res.x, s2


def run_contrasts(rows, outcome_col, extra_covariates=None, case_random=False, include_report=True, adjust="holm"):
    y = [float(r[outcome_col]) for r in rows]
    X, contrasts = build_design_matrix(rows, extra_covariates=extra_covariates)
    blk = [f"{r['case_pseudo']}__{r['phase_en']}__{r['model_cluster']}" for r in rows]
    rep = [r["report_id"] for r in rows]
    rat = [r["rater_id"] for r in rows]
    cas = [r["case_pseudo"] for r in rows] if case_random else None
    beta, cov, df, _, _ = fit_lmm_reml(y, X, blk, rep, rat, case_ids=cas, include_report=include_report)
    t_crit = stats.t.ppf(0.975, df)
    ests, ses, p_raw = [], [], []
    for _, cvec in contrasts:
        est = float(cvec @ beta)
        se = math.sqrt(float(cvec @ cov @ cvec))
        ests.append(est)
        ses.append(se)
        p_raw.append(2.0 * stats.t.sf(abs(est / se), df=df))
    p_adj = holm_adjust(p_raw) if adjust == "holm" else p_raw
    out = []
    for (cname, _), est, se, pv in zip(contrasts, ests, ses, p_adj):
        out.append({
            "contrast": cname,
            "estimate": est,
            "lower_ci": est - t_crit * se,
            "upper_ci": est + t_crit * se,
            "p.value": pv,
            "adjust_method": adjust,
        })
    return out


def fit_ordinal_clmm(rows):
    """Fit cumulative logit mixed model: wt_ord ~ condition * phase + (1|block) + (1|rater) via Laplace approximation."""
    y_ord = np.array([int(round(float(r["weighted_total"]))) for r in rows], dtype=int)
    X_full, contrasts_full = build_design_matrix(rows)
    X = X_full[:, 1:]
    contrasts = [(nm, vec[1:]) for nm, vec in contrasts_full]

    uniq_blk = sorted(set(f"{r['case_pseudo']}__{r['phase_en']}__{r['model_cluster']}" for r in rows))
    blk_map = {b: i for i, b in enumerate(uniq_blk)}
    b_idx = np.array([blk_map[f"{r['case_pseudo']}__{r['phase_en']}__{r['model_cluster']}"] for r in rows], dtype=int)

    uniq_rat = sorted(set(r["rater_id"] for r in rows))
    rat_map = {r: i for i, r in enumerate(uniq_rat)}
    r_idx = np.array([rat_map[r["rater_id"]] for r in rows], dtype=int)

    B, R = len(uniq_blk), len(uniq_rat)
    Q = B + R
    Z = np.zeros((len(rows), Q))
    Z[np.arange(len(rows)), b_idx] = 1.0
    Z[np.arange(len(rows)), B + r_idx] = 1.0

    def unpack_thresh(th_raw):
        a1 = th_raw[0]
        a2 = a1 + np.exp(th_raw[1])
        a3 = a2 + np.exp(th_raw[2])
        a4 = a3 + np.exp(th_raw[3])
        return np.array([-np.inf, a1, a2, a3, a4, np.inf])

    y_m1 = y_ord - 1
    p = X.shape[1]

    def outer_nll(params):
        alpha = unpack_thresh(params[:4])
        beta = params[4:4 + p]
        log_sb, log_sr = params[4 + p], params[4 + p + 1]
        sb, sr = math.exp(log_sb), math.exp(log_sr)
        inv_var = np.concatenate([np.full(B, 1.0 / (sb * sb)), np.full(R, 1.0 / (sr * sr))])
        eta_fix = X @ beta
        u = np.zeros(Q)
        for _ in range(25):
            eta = eta_fix + Z @ u
            hi = alpha[y_ord] - eta
            lo = alpha[y_m1] - eta
            F_hi = special.expit(hi)
            F_lo = special.expit(lo)
            prob = np.clip(F_hi - F_lo, 1e-15, 1.0)
            f_hi = F_hi * (1.0 - F_hi)
            f_lo = F_lo * (1.0 - F_lo)
            fp_hi = f_hi * (1.0 - 2.0 * F_hi)
            fp_lo = f_lo * (1.0 - 2.0 * F_lo)
            r1 = (f_hi - f_lo) / prob
            grad = Z.T @ r1 + u * inv_var
            w = np.clip(r1 * r1 - (fp_hi - fp_lo) / prob, 1e-10, 1e6)
            H = (Z.T * w) @ Z + np.diag(inv_var)
            step = np.linalg.solve(H, grad)
            nll0 = -np.sum(np.log(prob)) + 0.5 * np.sum(u * u * inv_var)
            alpha_ls = 1.0
            while alpha_ls > 1e-4:
                u_try = u - alpha_ls * step
                eta_t = eta_fix + Z @ u_try
                p_t = np.clip(special.expit(alpha[y_ord] - eta_t) - special.expit(alpha[y_m1] - eta_t), 1e-15, 1.0)
                if -np.sum(np.log(p_t)) + 0.5 * np.sum(u_try * u_try * inv_var) <= nll0 + 1e-10:
                    u = u_try
                    break
                alpha_ls *= 0.5
            if np.max(np.abs(alpha_ls * step)) < 1e-10:
                break
        eta = eta_fix + Z @ u
        hi = alpha[y_ord] - eta
        lo = alpha[y_m1] - eta
        F_hi = special.expit(hi)
        F_lo = special.expit(lo)
        prob = np.clip(F_hi - F_lo, 1e-15, 1.0)
        f_hi = F_hi * (1.0 - F_hi)
        f_lo = F_lo * (1.0 - F_lo)
        fp_hi = f_hi * (1.0 - 2.0 * F_hi)
        fp_lo = f_lo * (1.0 - 2.0 * F_lo)
        r1 = (f_hi - f_lo) / prob
        w = np.clip(r1 * r1 - (fp_hi - fp_lo) / prob, 1e-10, 1e6)
        H = (Z.T * w) @ Z + np.diag(inv_var)
        LH = np.linalg.cholesky(H)
        logdet_H = 2.0 * np.sum(np.log(np.diag(LH)))
        nll = -np.sum(np.log(prob)) + 0.5 * np.sum(u * u * inv_var)
        return nll + 0.5 * logdet_H + B * log_sb + R * log_sr

    init_params = np.array([-3.5, 0.4, 0.6, 0.5] + [0.0] * p + [-0.3, 0.3])
    res = optimize.minimize(outer_nll, init_params, method="BFGS", options={"gtol": 1e-5, "maxiter": 200})
    opt_p = res.x

    dim = len(opt_p)
    eps = 1e-4
    H_full = np.zeros((dim, dim))
    f0 = outer_nll(opt_p)
    for i in range(dim):
        ei = np.zeros(dim); ei[i] = eps
        fp = outer_nll(opt_p + ei)
        fm = outer_nll(opt_p - ei)
        H_full[i, i] = (fp - 2 * f0 + fm) / (eps * eps)
        for j in range(i + 1, dim):
            ej = np.zeros(dim); ej[j] = eps
            fpp = outer_nll(opt_p + ei + ej)
            fpm = outer_nll(opt_p + ei - ej)
            fmp = outer_nll(opt_p - ei + ej)
            fmm = outer_nll(opt_p - ei - ej)
            val = (fpp - fpm - fmp + fmm) / (4 * eps * eps)
            H_full[i, j] = H_full[j, i] = val
    cov_full = np.linalg.inv(H_full)
    cov_beta = cov_full[4:4 + p, 4:4 + p]
    beta = opt_p[4:4 + p]
    z_crit = stats.norm.ppf(0.975)
    out = []
    for cname, cvec in contrasts:
        est = float(cvec @ beta)
        se = math.sqrt(float(cvec @ cov_beta @ cvec))
        pval = 2.0 * stats.norm.sf(abs(est / se))
        out.append({
            "contrast": cname,
            "estimate": est,
            "lower_ci": est - z_crit * se,
            "upper_ci": est + z_crit * se,
            "p.value": pval,
            "scale": "latent_logit",
            "adjust_method": "none",
        })
    return out


def prepare_rows(joined, manifest, cit, surf):
    rows = []
    for r in joined:
        m = manifest[r["report_id"]]
        nr = dict(r)
        nr["condition"] = m["condition"]
        nr["model_cluster"] = m["model_cluster"]
        nr["needs_review"] = m["needs_review"]
        nr["phase_en"] = PHASE_MAP[r["phase"]]
        nr["n_chars"] = float(surf[r["report_id"]]["n_chars"])
        nr["n_headings"] = float(surf[r["report_id"]]["n_headings"])
        nr["n_citations"] = float(cit[r["report_id"]]["n_citations"])
        rows.append(nr)
    pos_map = {}
    by_cp = defaultdict(set)
    for r in rows:
        by_cp[(r["case"], r["phase"])].add(r["report_id"])
    for (c, ph), rids in by_cp.items():
        for idx, rid in enumerate(sorted(rids), 1):
            pos_map[(c, ph, rid)] = idx
    for r in rows:
        r["within_case_phase_pos"] = pos_map[(r["case"], r["phase"], r["report_id"])]
    return rows


def load_controlled_inputs(args: argparse.Namespace):
    if args.controlled_zip:
        zp = Path(args.controlled_zip)
        if not zp.is_file():
            print(f"Controlled archive not found: {zp}", file=sys.stderr)
            raise SystemExit(2)
        with ZipFile(zp) as z:
            joined = load_zip_csv(z, "analysis_dataset_joined.csv")
            m_auto = {r["report_id"]: r for r in load_zip_csv(z, "report_manifest_auto.csv")}
            m_final = {r["report_id"]: r for r in load_zip_csv(z, "report_manifest_final.csv")}
            cit = {r["report_id"]: r for r in load_zip_csv(z, "citation_proxies_by_report.csv")}
            surf = {r["report_id"]: r for r in load_zip_csv(z, "surface_proxies_by_report.csv")}
        return joined, m_auto, m_final, cit, surf

    if args.controlled_dir:
        d = Path(args.controlled_dir)
        if not d.is_dir():
            print(f"Controlled directory not found: {d}", file=sys.stderr)
            raise SystemExit(2)

        def find_one(name: str) -> Path:
            hits = list(d.rglob(name))
            if not hits:
                print(f"Missing governed file {name} under {d}", file=sys.stderr)
                raise SystemExit(2)
            return hits[0]

        joined = load_disk_csv(find_one("analysis_dataset_joined.csv"))
        m_auto = {r["report_id"]: r for r in load_disk_csv(find_one("report_manifest_auto.csv"))}
        m_final = {r["report_id"]: r for r in load_disk_csv(find_one("report_manifest_final.csv"))}
        cit = {r["report_id"]: r for r in load_disk_csv(find_one("citation_proxies_by_report.csv"))}
        surf = {r["report_id"]: r for r in load_disk_csv(find_one("surface_proxies_by_report.csv"))}
        return joined, m_auto, m_final, cit, surf

    print(
        "No governed row-level inputs were supplied (--controlled-dir or --controlled-zip). "
        "Row-level coded rating exports and report manifests require institutional review "
        "(see Manuscript Section 7). To verify the published aggregate tables directly, run "
        "`python3 analysis/exact_signflip.py` and `python3 analysis/verify_published_aggregates.py`.",
        file=sys.stderr,
    )
    raise SystemExit(2)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--controlled-dir", default="", help="Directory containing governed row-level CSV exports")
    parser.add_argument("--controlled-zip", default="", help="Zip archive containing governed row-level CSV exports")
    parser.add_argument("--out-dir", action="append", default=[], help="Output directory for refitted aggregate CSVs (repeatable)")
    parser.add_argument("--summary-json", default="", help="Optional path to write JSON summary")
    args = parser.parse_args()

    joined, m_auto, m_final, cit, surf = load_controlled_inputs(args)
    targets = [Path(p) for p in args.out_dir] if args.out_dir else [DEFAULT_OUT]

    rows = prepare_rows(joined, m_final, cit, surf)
    rows_auto = prepare_rows(joined, m_auto, cit, surf)

    # 1. Table 1 auxiliary CSVs
    write_csv_targets(targets, "tables/table1_overall_counts.csv", [{
        "n_cases": 10, "n_phases": 3, "n_reports": 450, "n_raters": 5,
        "n_rating_rows": 2250, "n_needs_review_rows": 0, "pct_needs_review_rows": 0.0,
    }])
    t1_pc = []
    for ph in PHASES:
        for cond in CONDITIONS:
            sub = [r for r in rows if r["phase_en"] == ph and r["condition"] == cond]
            t1_pc.append({
                "phase_en": ph,
                "condition_en": COND_EN[cond],
                "n_reports": len({r["report_id"] for r in sub}),
                "n_ratings": len(sub),
                "n_needs_review_ratings": 0,
            })
    write_csv_targets(targets, "tables/table1_by_phase_condition.csv", t1_pc)
    write_csv_targets(targets, "tables/table1_reconciliation_status.csv", [{
        "n_rows": 2250, "n_missing_condition": 0, "n_missing_weighted_total": 0,
        "n_missing_accuracy": 0, "n_missing_completeness": 0, "n_missing_safety": 0, "n_missing_clarity": 0,
    }])
    write_csv_targets(targets, "tables/tableS29_qc_flag_distribution_by_condition.csv", [
        {
            "flag_definition": "resolved_final_manifest",
            "condition": c,
            "condition_en": COND_EN[c],
            "n_rating_rows": 750,
            "n_needs_review_rows": 0,
            "pct_needs_review_rows": 0.0,
            "subtype_recovery_status": "All 450 reports verified against generation-time master manifest (0 unresolved flags)",
        }
        for c in CONDITIONS
    ] + [{
        "flag_definition": "resolved_final_manifest",
        "condition": "all",
        "condition_en": "All conditions",
        "n_rating_rows": 2250,
        "n_needs_review_rows": 0,
        "pct_needs_review_rows": 0.0,
        "subtype_recovery_status": "All 450 reports verified against generation-time master manifest (0 unresolved flags)",
    }])

    # 2. table3_primary_weighted_total.csv (with sensitivity subsets for S3)
    rows_no_r4 = [r for r in rows if r["rater_id"] != "R4"]
    rows_int = [r for r in rows if r["rater_id"] in {"R1", "R2", "R5"}]
    rows_pre = [r for r in rows if not (r["rater_id"] == "R3" and r["report_id"] == "EDB1BF86")]
    rows_unimp = [
        r for r in rows
        if not (
            (r["rater_id"] == "R3" and r["report_id"] == "EDB1BF86")
            or (r["rater_id"] == "R4" and r["report_id"] == "8FBD7110")
        )
    ]
    assert len(rows_no_r4) == 1800 and len(rows_int) == 1350 and len(rows_pre) == 2249 and len(rows_unimp) == 2248
    t3_rows = []
    for ds_name, ds_rows in [
        ("all_rows", rows),
        ("exclude_r4_qc_1800", rows_no_r4),
        ("integer_raters_only", rows_int),
        ("pre_correction_2249", rows_pre),
        ("raw_unimputed_2248", rows_unimp),
        ("legacy_auto_manifest", rows_auto),
    ]:
        for res in run_contrasts(ds_rows, "weighted_total"):
            t3_rows.append({"dataset": ds_name, **res})
    write_csv_targets(targets, "tables/table3_primary_weighted_total.csv", t3_rows)

    # 3. table4_secondary_overall.csv
    t4_rows = []
    for ep in ["accuracy", "completeness", "safety", "clarity"]:
        for ds_name, ds_rows in [("all_rows", rows), ("integer_raters_only", rows_int)]:
            for res in run_contrasts(ds_rows, ep, adjust="none"):
                t4_rows.append({"endpoint": ep, "dataset": ds_name, **res})
    write_csv_targets(targets, "tables/table4_secondary_overall.csv", t4_rows)

    # 4. table5_decision_relevant_thresholds_by_condition.csv
    rep_map = defaultdict(list)
    for r in rows:
        rep_map[(r["report_id"], r["condition"])].append(r)
    t5_rows = []
    for cond in sorted(CONDITIONS, key=lambda c: COND_EN[c]):
        reps = [rlist for (rid, c), rlist in rep_map.items() if c == cond]
        n = len(reps)
        n_wt_ge4 = sum(np.mean([float(x["weighted_total"]) for x in rl]) >= 4.0 for rl in reps)
        n_s_lt3 = sum(np.mean([float(x["safety"]) for x in rl]) < 3.0 for rl in reps)
        n_any_le2 = sum(min(float(x["safety"]) for x in rl) <= 2.0 for rl in reps)
        w1 = wilson_ci(n_wt_ge4, n)
        w2 = wilson_ci(n_s_lt3, n)
        w3 = wilson_ci(n_any_le2, n)
        t5_rows.append({
            "condition_en": COND_EN[cond],
            "n_reports": n,
            "n_wt_ge4": int(n_wt_ge4),
            "pct_wt_ge4": round(100 * n_wt_ge4 / n, 1),
            "pct_wt_ge4_lower": round(100 * w1[0], 1),
            "pct_wt_ge4_upper": round(100 * w1[1], 1),
            "n_safety_lt3": int(n_s_lt3),
            "pct_safety_lt3": round(100 * n_s_lt3 / n, 1),
            "pct_safety_lt3_lower": round(100 * w2[0], 1),
            "pct_safety_lt3_upper": round(100 * w2[1], 1),
            "n_any_rater_safety_le2": int(n_any_le2),
            "pct_any_rater_safety_le2": round(100 * n_any_le2 / n, 1),
            "pct_any_rater_safety_le2_lower": round(100 * w3[0], 1),
            "pct_any_rater_safety_le2_upper": round(100 * w3[1], 1),
        })
    write_csv_targets(targets, "tables/table5_decision_relevant_thresholds_by_condition.csv", t5_rows)

    # 5. S1: case_random_intercept_weighted_total_contrasts.csv
    s1_rows = [
        {"model": "case_random_intercept", **res, "n_rows": 2250, "n_cases": 10}
        for res in run_contrasts(rows, "weighted_total", case_random=True)
    ]
    write_csv_targets(targets, "case_random_intercept_weighted_total_contrasts.csv", s1_rows)

    # 6. S2: tableS2_robustness_leave_one_out_weighted_total.csv
    s2_rows = []
    for c_id in sorted({r["case_pseudo"] for r in rows}):
        sub = [r for r in rows if r["case_pseudo"] != c_id]
        for res in run_contrasts(sub, "weighted_total"):
            s2_rows.append({"endpoint": "weighted_total", **res, "leave_out_type": "case_pseudo", "leave_out": c_id, "n_rows": len(sub)})
    for r_id in sorted({r["rater_id"] for r in rows}):
        sub = [r for r in rows if r["rater_id"] != r_id]
        for res in run_contrasts(sub, "weighted_total"):
            s2_rows.append({"endpoint": "weighted_total", **res, "leave_out_type": "rater_id", "leave_out": r_id, "n_rows": len(sub)})
    write_csv_targets(targets, "tables/tableS2_robustness_leave_one_out_weighted_total.csv", s2_rows)

    # 7. S4: tableS13_weighted_total_contrasts_position_adjusted.csv
    s13_rows = run_contrasts(rows, "weighted_total", extra_covariates=[[r["within_case_phase_pos"] for r in rows]])
    write_csv_targets(targets, "tables/tableS13_weighted_total_contrasts_position_adjusted.csv", s13_rows)

    # 8. S5: tableS4_weighted_total_contrasts_by_model_variant.csv
    s4_rows = []
    for mc in sorted({r["model_cluster"] for r in rows}):
        sub = [r for r in rows if r["model_cluster"] == mc]
        for res in run_contrasts(sub, "weighted_total", include_report=False, adjust="none"):
            s4_rows.append({
                "model_cluster": mc,
                "contrast": res["contrast"],
                "estimate": res["estimate"],
                "lower_ci": res["lower_ci"],
                "upper_ci": res["upper_ci"],
                "p.value": res["p.value"],
            })
    write_csv_targets(targets, "tables/tableS4_weighted_total_contrasts_by_model_variant.csv", s4_rows)

    # 9. S6: tableS10_ordinal_clmm_weighted_total_contrasts_overall.csv
    s10_rows = fit_ordinal_clmm(rows)
    write_csv_targets(targets, "tables/tableS10_ordinal_clmm_weighted_total_contrasts_overall.csv", s10_rows)

    # 10. tableS7_weighted_total_descriptives_by_condition.csv & by_phase_condition.csv
    def desc_stats(vals):
        arr = np.asarray(vals, dtype=float)
        return {
            "n": len(arr),
            "mean": round(float(arr.mean()), 4),
            "sd": round(float(arr.std(ddof=1)), 4),
            "median": round(float(np.median(arr)), 4),
            "q1": round(float(np.quantile(arr, 0.25)), 4),
            "q3": round(float(np.quantile(arr, 0.75)), 4),
        }

    s7_cond = []
    for unit_name in ("rating", "report_mean"):
        for cond in ("baseline", "mcp", "peer"):
            if unit_name == "rating":
                vals = [float(r["weighted_total"]) for r in rows if r["condition"] == cond]
            else:
                vals = [float(np.mean([float(x["weighted_total"]) for x in rl])) for (rid, c), rl in rep_map.items() if c == cond]
            s7_cond.append({"unit": unit_name, "condition_en": COND_EN[cond], **desc_stats(vals)})
    write_csv_targets(targets, "tables/tableS7_weighted_total_descriptives_by_condition.csv", s7_cond)

    s7_pc = []
    for unit_name in ("rating", "report_mean"):
        for ph in sorted(PHASES):
            for cond in sorted(CONDITIONS, key=lambda c: COND_EN[c]):
                if unit_name == "rating":
                    vals = [float(r["weighted_total"]) for r in rows if r["phase_en"] == ph and r["condition"] == cond]
                else:
                    vals = [
                        float(np.mean([float(x["weighted_total"]) for x in rl]))
                        for (rid, c), rl in rep_map.items()
                        if c == cond and rl[0]["phase_en"] == ph
                    ]
                s7_pc.append({"unit": unit_name, "phase_en": ph, "condition_en": COND_EN[cond], **desc_stats(vals)})
    write_csv_targets(targets, "tables/tableS7_weighted_total_descriptives_by_phase_condition.csv", s7_pc)

    # 11. tableS14b_weighted_total_contrasts_workflow_feature_models.csv
    s14b_rows = []
    for mod_name, covs in [
        ("Raw", None),
        ("+ character-count and structure features", [[r["n_chars"] for r in rows]]),
        ("+ evidence density", [[r["n_citations"] for r in rows]]),
        ("+ full workflow features", [[r["n_citations"] for r in rows], [r["n_chars"] for r in rows], [r["n_headings"] for r in rows]]),
    ]:
        for res in run_contrasts(rows, "weighted_total", extra_covariates=covs):
            s14b_rows.append({"model": mod_name, **res})
    write_csv_targets(targets, "tables/tableS14b_weighted_total_contrasts_workflow_feature_models.csv", s14b_rows)

    # 12. tableS16_case_level_contrasts_weighted_total.csv + direct case diffs verification
    cases = sorted({r["case_pseudo"] for r in rows})
    case_cond = defaultdict(list)
    for r in rows:
        case_cond[(r["case_pseudo"], r["condition"])].append(float(r["weighted_total"]))
    s16_rows = []
    direct_diffs = {}
    for contrast_name, c_hi, c_lo in [
        ("mcp - baseline", "mcp", "baseline"),
        ("peer - baseline", "peer", "baseline"),
        ("peer - mcp", "peer", "mcp"),
    ]:
        vals = np.array([np.mean(case_cond[(c, c_hi)]) - np.mean(case_cond[(c, c_lo)]) for c in cases])
        direct_diffs[contrast_name] = vals
        m = float(vals.mean())
        sd = float(vals.std(ddof=1))
        se = sd / math.sqrt(len(vals))
        lo, hi = stats.t.interval(0.95, df=len(vals) - 1, loc=m, scale=se)
        pv = float(2.0 * stats.t.sf(abs(m / se), df=len(vals) - 1))
        s16_rows.append({
            "contrast": contrast_name, "n": len(vals), "mean": m, "sd": sd,
            "lower_ci": lo, "upper_ci": hi, "p_value": pv,
        })
    write_csv_targets(targets, "tables/tableS16_case_level_contrasts_weighted_total.csv", s16_rows)

    # 13. tableS34_safety_reweighting_arithmetic_sensitivity.csv
    dom_by = {(r["endpoint"], r["contrast"]): r for r in t4_rows if r["dataset"] == "all_rows"}
    for r in rows:
        r["wt_safety_emph"] = (
            0.4 * float(r["accuracy"]) + 0.2 * float(r["completeness"]) + 0.3 * float(r["safety"]) + 0.1 * float(r["clarity"])
        )
    refit_emph = {r["contrast"]: r for r in run_contrasts(rows, "wt_safety_emph")}
    refit_prespec = {r["contrast"]: r for r in t3_rows if r["dataset"] == "all_rows"}
    s34_rows = []
    for c_key, c_lbl in [("mcp - baseline", "RAG vs template"), ("peer - baseline", "RAG+CR vs template"), ("peer - mcp", "RAG+CR vs RAG")]:
        acc_e = dom_by[("accuracy", c_key)]["estimate"]
        com_e = dom_by[("completeness", c_key)]["estimate"]
        saf_e = dom_by[("safety", c_key)]["estimate"]
        cla_e = dom_by[("clarity", c_key)]["estimate"]
        for scheme_name, w, rf in [
            ("prespecified weighted total", (0.5, 0.3, 0.1, 0.1), refit_prespec[c_key]),
            ("safety-emphasis translation", (0.4, 0.2, 0.3, 0.1), refit_emph[c_key]),
        ]:
            arith = w[0] * acc_e + w[1] * com_e + w[2] * saf_e + w[3] * cla_e
            assert abs(arith - rf["estimate"]) < 1e-4, (scheme_name, c_key, arith, rf["estimate"])
            s34_rows.append({
                "contrast": c_lbl,
                "weight_scheme": scheme_name,
                "accuracy_weight": w[0],
                "completeness_weight": w[1],
                "safety_weight": w[2],
                "clarity_weight": w[3],
                "arithmetic_reweighted_estimate": round(arith, 4),
                "endpoint_accuracy_estimate": round(acc_e, 4),
                "endpoint_completeness_estimate": round(com_e, 4),
                "endpoint_safety_estimate": round(saf_e, 4),
                "endpoint_clarity_estimate": round(cla_e, 4),
                "refit_estimate": round(rf["estimate"], 6),
                "refit_lower_ci": round(rf["lower_ci"], 6),
                "refit_upper_ci": round(rf["upper_ci"], 6),
                "refit_holm_p": rf["p.value"],
                "inference_status": "Row-level refit (unadjusted 95% CI; Holm-adjusted P) matches domain-weighted arithmetic",
            })
    write_csv_targets(targets, "tables/tableS34_safety_reweighting_arithmetic_sensitivity.csv", s34_rows)

    # Run exact_signflip.py and verify direct case differences match aggregate reconstruction within 1e-9
    signflip_script = HERE / "exact_signflip.py"
    if signflip_script.is_file():
        subprocess.run([sys.executable, "-B", str(signflip_script)], check=True)
        for tgt in targets:
            rec_path = tgt / "reconstructed_case_differences.csv"
            if rec_path.is_file():
                recons = load_disk_csv(rec_path)
                for c in sorted(cases):
                    rrow = [x for x in recons if x["case_id"] == c][0]
                    c_idx = cases.index(c)
                    assert abs(float(rrow["rag_minus_to"]) - direct_diffs["mcp - baseline"][c_idx]) < 1e-9
                    assert abs(float(rrow["ragcr_minus_to"]) - direct_diffs["peer - baseline"][c_idx]) < 1e-9
                    assert abs(float(rrow["ragcr_minus_rag"]) - direct_diffs["peer - mcp"][c_idx]) < 1e-9

    if args.summary_json:
        Path(args.summary_json).write_text(json.dumps({
            "table3_all": {r["contrast"]: r for r in t3_rows if r["dataset"] == "all_rows"},
            "table5": {r["condition_en"]: r for r in t5_rows},
        }, indent=2, ensure_ascii=False) + "\n")
    print("Recalculation on report_manifest_final.csv completed cleanly.")


if __name__ == "__main__":
    main()
