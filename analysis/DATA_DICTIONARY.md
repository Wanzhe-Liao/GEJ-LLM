# Data dictionary

Two distinct artifacts in this codebase use the domain names `accuracy`, `completeness`, `safety`, and `clarity` with weights `0.5`, `0.3`, `0.1`, and `0.1`. They are separate stages and are never mixed in analysis.

## 1. Human clinician rating dataset (study endpoint; controlled institutional access)

Read by `analysis/recalculate_final_manifest.py` (and historically by `analysis/primary_analysis.R`) from the coded clinician rating export (`scores_long.csv` / `analysis_dataset_joined.csv`) linked to the generation-time master manifest (`report_manifest_final.csv`). Row-level files are not distributed in the public repository; see Manuscript Section 7 for institutional access procedures.

| Column | Meaning |
| --- | --- |
| `rater_id` | Pseudonymous clinician coauthor code (`R1`, `R2`, `R3`, `R4`, or `R5`). Not a public key to named individuals; the identity key is retained by the institution. |
| `report_id` | Masked 8-character hexadecimal report identifier (450 distinct reports across 10 cases × 3 care phases × 5 model variants × 3 workflows). |
| `case_pseudo` | Coded source case identifier (`C1`–`C10`). |
| `phase` | Sequential care-phase view of each case (`门诊阶段` = Outpatient, `住院阶段` = Inpatient, `出院阶段` = Discharge). |
| `model_cluster` | Fixed generation model variant (`gpt-5`, `grok-4`, `gemini-3-pro`, `kimi-k2-thinking`, or `qwen3-max`), assigned from `report_manifest_final.csv`. |
| `condition` | Workflow arm from `report_manifest_final.csv`: `baseline` = Template-only (`TO`); `mcp` = Guideline RAG (`RAG`); `peer` = RAG plus multi-model critique and revision (`RAG+CR`). `peer` denotes the generation workflow, not an AI outcome rater. |
| `accuracy`, `completeness`, `safety`, `clarity` | Clinician-assigned scores on a 1–5 rubric (`safety` denotes author-rated perceived safety, not externally adjudicated clinical harm). Although the protocol specified 0.5-point steps, the Excel templates did not enforce step validation (`R1`, `R2`, `R5` entered integers only; `R3` entered tenth-point values in 31/450 rows and `R4` in 450/450 rows). |
| `weighted_total` | Recomputed from domain scores as `0.5 * accuracy + 0.3 * completeness + 0.1 * safety + 0.1 * clarity`. |
| `needs_review` | Manifest reconciliation indicator (`0` across all 450 reports / 2,250 rows under `report_manifest_final.csv`). |

### Workbook audit reconciliations documented in the revised manuscript

Across all 150 raw clinician Excel workbooks (30 workbooks × 5 raters = 2,250 rows):
- **2,248 / 2,250 rows** matched identically by `report_id` and all four domain scores.
- **`R3` / `EDB1BF86`:** `clarity` was blank in the raw Excel workbook and recorded as `4` in the coded export (`weighted_total = 3.1`). Sensitivity analyses omitting this row (`pre_correction_2249`) and omitting both reconciled rows (`raw_unimputed_2248`) are reported in `published_aggregates/tables/table3_primary_weighted_total.csv` (Supplementary Table S3).
- **`R4` / `8FBD7110`:** A duplicate report-ID paste (`55F2025F`) on worksheet row 11 matched the distributed blank template's row-11 ID (`8FBD7110`) across all four domain scores.
- **Manifest alignment:** An earlier heuristic manifest (`report_manifest_auto.csv`) contained 64 discordant workflow assignments (31 `RAG`/`RAG+CR` swaps in each direction plus 1 `TO`/`RAG+CR` swap) and misassigned model-variant labels. All revised manuscript and supplementary analyses use `report_manifest_final.csv` (`legacy_auto_manifest` is retained in Supplementary Table S3 for transparency).

## 2. Generation-time AI critique output (intermediate workflow artifact, NOT the study endpoint)

`src/services/peerReview.ts` (`evaluateReport` / `runPeerReview`) prompts each of the five generation models to review a retrieval-augmented draft during the `RAG+CR` (`peer`) generation workflow and returns JSON critique comments plus four domain numbers so the generator can produce a single revised report. Those model outputs are never merged into `scores_long.csv` or analyzed as study endpoints.

## 3. Publicly included aggregate tables

`analysis/published_aggregates/` contains the 20 refitted aggregate CSV tables supporting the main text, Figures 1–4, and Supplementary Tables S1–S8. Run `python3 analysis/exact_signflip.py` and `python3 analysis/verify_published_aggregates.py` to verify numerical closure and manuscript consistency.
