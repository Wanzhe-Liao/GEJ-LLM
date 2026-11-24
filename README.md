# GEJ-LLM

Source code, prompt templates, revision analysis scripts, and aggregate verification checks for the study:

> **Guideline retrieval with multi-model critique and revision for AI-generated gastroesophageal junction cancer reports: a single-center author-rated paired evaluation** (*Intelligent Oncology*, manuscript `INTONC-D-26-00106`)

## Human clinician endpoint vs. generation-time AI critique

Two distinct components in this project reference the four rubric domains (`accuracy`, `completeness`, `safety`, `clarity`) and the protocol-specified weights (`0.5`, `0.3`, `0.1`, `0.1`):

1. **Human clinician outcome ratings (the study endpoint analyzed in the paper):**
   - Five clinician coauthors (`R1–R5`) independently scored all 450 de-identified reports across 150 offline Excel scoring workbooks (30 workbooks per rater), yielding **2,250 human assessments**.
   - All statistical tables and figures in the revised manuscript are refitted on the reconciled human rating export (`scores_long.csv` / `analysis_dataset_joined.csv`) aligned with the generation-time master manifest (`report_manifest_final.csv`, 450 reports, 0 unresolved flags) via [`analysis/recalculate_final_manifest.py`](analysis/recalculate_final_manifest.py).
   - Column definitions and audit provenance are documented in [`analysis/DATA_DICTIONARY.md`](analysis/DATA_DICTIONARY.md) and [`analysis/PROVENANCE.md`](analysis/PROVENANCE.md).

2. **Generation-time AI peer critique (`src/services/peerReview.ts`, NOT the study endpoint):**
   - Inside the third generation workflow (`RAG+CR`, coded `peer`), `runPeerReview` / `evaluateReport` prompts each of the five generation models to critique each retrieval-augmented draft along the same four rubric dimensions so that comments can be aggregated for a single revision pass.
   - Those model-generated scores are intermediate generation artifacts used solely to construct the `RAG+CR` draft text; they are **not** rows in the human rating dataset and are **not** analyzed as study outcomes.

### Workflow and model codes

| Code in analysis files | Manuscript label | Description | Design-implied generation-model calls |
| --- | --- | --- | ---: |
| `baseline` | `TO` | Single-pass template-only report generation | 150 |
| `mcp` | `RAG` | Guideline retrieval-augmented generation (query formulation + retrieval-informed draft) | 300 |
| `peer` | `RAG+CR` | Multi-model critique (`5 × 5` per block = 750 calls) + single-pass revision (150 calls) on existing `RAG` drafts | 900 additional |

Total design-implied generation-model calls across the 450 reports = **1,350** (excluding internal retrieval operations and auxiliary JSON-repair/orchestration calls; see `src/utils/models.ts` and `clinical_rag_system/src/l2_langgraph_workflow.py`). The five fixed generation model variants (`M1–M5`) configured in `src/utils/models.ts` are `gpt-5`, `grok-4`, `gemini-3-pro-preview-11-2025`, `kimi-k2-thinking`, and `qwen3-max`.

## Reproducing the published aggregate checks

Published aggregate result tables behind the revised manuscript and Supplementary Tables S1–S8 are provided in [`analysis/published_aggregates/`](analysis/published_aggregates/) (containing aggregate summary statistics only; no row-level ratings, patient records, report texts, or rater identities). From a fresh clone of this repository, run:

```bash
python3 analysis/exact_signflip.py
python3 analysis/verify_published_aggregates.py
```

- `analysis/exact_signflip.py` reconstructs the 10 paired case-level differences from the full-data and leave-one-case-out aggregates (`10*M - 9*M(-i)`, verified within `1e-9` of direct row-level paired case means) and enumerates all `2^10 = 1,024` sign-flip assignments for exact two-sided and `max-|t|` family-wise P values.
- `analysis/verify_published_aggregates.py` verifies the refitted primary mixed-model contrasts (`+0.196`, `+0.158`, `+0.038`), visible-feature adjustments (`+0.046` fully adjusted; `831 / 1,120 / 1,496` mean characters), author-rated low-safety flag counts (`79/150`, `66/150`, `48/150`), safety reweighting (`+0.196`, `+0.158`), reliability (`ICC[2,1] = 0.131` composite; `0.117` safety), rater sensitivity subsets (`n = 1,800`, `n = 1,350`, `n = 2,248`), and workflow call counts (`1,350`).

### Row-level audit and mixed-model recalculation scripts (controlled inputs)

Row-level coded rating exports (`scores_long.csv`, `analysis_dataset_joined.csv`), report manifests (`report_manifest_final.csv`), and de-identified report extracts are held under institutional governance (requests may be directed to the corresponding authors as described in Manuscript Section 7). Two scripts operate on those controlled files and exit cleanly with status `2` when invoked without them:

```bash
python3 analysis/audit_editor_ratings.py /path/to/scores_long.csv
python3 analysis/recalculate_final_manifest.py --controlled-dir /path/to/controlled_inputs
```

`analysis/primary_analysis.R` and `analysis/sensitivity_analysis.R` are retained as the initial R mixed-model scripts; for the revised manuscript, all primary and sensitivity models were refitted on `report_manifest_final.csv` via `analysis/recalculate_final_manifest.py`.

## Running the report-generation web application

```bash
pnpm install
cp .env.example .env
pnpm dev
```

- Prompt templates (in Chinese, matching the Chinese study vignettes and generated reports; historical prompts occasionally use `AEG` shorthand for adenocarcinoma of the esophagogastric junction, referred to as `GEJ` cancer in the manuscript): [`docs/LLM_PROMPTS.md`](docs/LLM_PROMPTS.md) and [`src/utils/prompts.ts`](src/utils/prompts.ts).
- Model endpoint configuration: [`src/utils/models.ts`](src/utils/models.ts).
- Local MCP/LightRAG service setup notes: [`docs/`](docs/) and [`clinical_rag_system/`](clinical_rag_system/) (component-level engineering documentation from system development; empirical study scope and evaluation results are defined strictly by the manuscript and [`analysis/`](analysis/)).
