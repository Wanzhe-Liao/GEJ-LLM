# Endpoint and analysis provenance (`INTONC-D-26-00106`)

## Separation between generation-time critique and clinician outcome ratings

- **Generation code (`src/`, `clinical_rag_system/`):** Implements the three report-generation workflows evaluated in the study:
  - `baseline` (`TO`): single-pass template generation (`150` calls across 10 cases × 3 phases × 5 models).
  - `mcp` (`RAG`): retrieval-query formulation plus retrieval-augmented report generation (`300` calls).
  - `peer` (`RAG+CR`): five-model critique (`src/services/peerReview.ts`: `runPeerReview` / `evaluateReport`, `750` calls) followed by single-pass revision by the original generator (`150` calls) on existing `RAG` drafts (`900` additional calls; `1,350` design-implied generation-model calls in total).
- **Study endpoint (`scores_long.csv` / `analysis_dataset_joined.csv`, controlled institutional access):** Contains **2,250 human clinician assessments** (450 reports × 5 clinician coauthors coded `R1–R5`) audited across all 150 raw offline Excel scoring workbooks. Outputs from `runPeerReview` / `evaluateReport` are generation-time intermediate prompts/artifacts and are **not** the study endpoint.

## Scripts in `analysis/`

| Script | Role | Inputs required |
| --- | --- | --- |
| `recalculate_final_manifest.py` | Authoritative revision reanalysis script (exact REML linear mixed models, Laplace cumulative-logit mixed model, Wilson score CIs, leave-one-case/rater refits, rater-quality subsets, safety reweighting refit, and five-model-variant stratification on `report_manifest_final.csv`). | Controlled row-level CSVs (`--controlled-dir` or `--controlled-zip`); exits with status `2` when absent. |
| `exact_signflip.py` | Reconstructs the 10 case-level paired differences (`10*M - 9*M(-i)`) from full-data and leave-one-case-out aggregates (matching direct row-level paired case means within `1e-9`) and runs complete `2^10 = 1,024` sign-flip enumeration. | Runs directly on `analysis/published_aggregates/` (or `../reports/analysis/results/`). |
| `verify_published_aggregates.py` | Checks the refitted aggregate CSVs against every key number reported in the revised manuscript and Supplementary Tables S1–S8. | Runs directly on `analysis/published_aggregates/` (or `../reports/analysis/results/`). |
| `audit_editor_ratings.py` | Validates structural completeness (2,250 rows, 450 reports, raters `R1–R5`, numeric 1–5 domain scores) of a supplied row-level human rating CSV without substituting model critique scores. | Path to row-level `scores_long.csv`; exits with status `2` when omitted. |
| `primary_analysis.R`, `sensitivity_analysis.R` | Initial R mixed-model scripts (`lme4` / `emmeans` / `psych` / `ordinal`), retained for historical reference and validated against `recalculate_final_manifest.py`. | Controlled row-level CSVs. |

## Governance boundary

No patient records, vignette texts, generated clinical report texts, raw clinician Excel workbooks, row-level rating exports, or clinician identity keys are stored in this public repository. Requests for governed research materials may be submitted to the corresponding authors for institutional review as stated in Section 7 of the manuscript.
