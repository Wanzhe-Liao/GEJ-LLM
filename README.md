# GEJ-LLM

Workflow code, analysis scripts, and reproducibility metadata for the iScience submission
"Critique-and-revise retrieval improves clinician-rated AI-generated gastroesophageal cancer reports".

This repository supports the manuscript Code Availability statement:

> Workflow code, analysis scripts, aggregate outputs, and reproducibility metadata will be released at https://github.com/Wanzhe-Liao/GEJ-LLM after institutional de-identification review.

## Repository scope

The public repository is limited to non-PHI materials:

- Statistical analysis scripts
- Report-generation and critique-and-revise workflow code
- RAG / MCP bridge and LightRAG retrieval service code
- De-identified prompt templates and architecture documentation
- Packaging / rendering scripts used for the submission workflow

The following materials are **excluded** and remain under institutional governance:
source-record-level case materials, full generated report texts, raw clinician score sheets,
chart-derived source materials, and restricted guideline full text.

## Structure

```text
.
├── analysis/                       # Core statistical analysis
│   ├── primary_analysis.R          # Primary mixed-effects analysis and contrasts
│   ├── sensitivity_analysis.R      # Leave-one-out and sign-flip sensitivity analyses
│   └── exact_signflip.py           # Exact case-cluster sign-flip enumeration
├── src/                            # L1 frontend / orchestration (React + Vite)
│   ├── services/
│   │   ├── reportGenerator.ts      # Baseline report generation, MCP optimization, revision
│   │   ├── peerReview.ts           # Cross-model 5×5 critique-and-revise evaluation
│   │   ├── mcpClient.ts            # Client for the local MCP bridge
│   │   └── clinicalGuidelines.ts   # Guideline-query helpers
│   ├── utils/
│   │   ├── prompts.ts              # De-identified prompt templates
│   │   ├── models.ts               # Model configuration and env-var mapping
│   │   ├── citationValidator.ts    # Runtime citation validation
│   │   └── apiConfig.ts            # API configuration diagnostics
│   └── types/                      # Shared TypeScript type definitions
├── clinical_rag_system/            # L2 LangGraph + L3 LightRAG services
│   ├── mcp_http_bridge.py          # FastAPI MCP HTTP bridge (port 8787)
│   ├── start_lightrag_custom.py    # LightRAG server startup (port 9621)
│   ├── src/
│   │   ├── l2_langgraph_workflow.py  # Corrective-RAG LangGraph workflow
│   │   ├── l1_mcp_tools.py         # MCP tool layer (sanitization, cache, monitoring)
│   │   ├── cache_manager.py        # Request-level cache
│   │   ├── security_utils.py       # Input validation helpers
│   │   └── performance_monitor.py  # Token/cost monitoring utilities
│   └── requirements.txt
├── docs/                           # Non-PHI architecture and prompt documentation
│   ├── LLM_PROMPTS.md              # Prompt template reference
│   ├── MCP_RAG_ARCHITECTURE.md     # L1→L2→L3 architecture overview
│   ├── API_SETUP_GUIDE.md          # API key / environment setup template
│   └── MCP_STARTUP_GUIDE.md        # Service startup guide
├── package.json                    # Node dependencies for the L1 frontend
├── tsconfig*.json                  # TypeScript configuration
├── vite.config.ts                  # Vite dev-server configuration
├── .env.example                    # Environment variable template (no real secrets)
└── .gitignore                      # Exclusions for secrets, build output, governed data
```

## Analysis scripts

The `analysis/` directory contains scripts that reproduce the primary and sensitivity
analyses from pseudonymized aggregate CSVs. Row-level ratings and source records are not
included in this repository.

## Workflow code

The L1/L2/L3 workflow implements a three-layer RAG + MCP pipeline:

1. **L1 – Frontend / orchestration (`src/`)**: receives structured case-phase input,
   generates baseline reports, calls the MCP bridge for guideline-grounded optimization,
   and runs cross-model critique-and-revise scoring.
2. **L2 – MCP HTTP Bridge + LangGraph (`clinical_rag_system/`)**: routes MCP tool calls
   through a corrective-RAG workflow that rephrases queries, retrieves documents,
   grades relevance, and synthesizes cited answers.
3. **L3 – LightRAG (`clinical_rag_system/start_lightrag_custom.py`)**: hybrid vector
   and knowledge-graph retrieval over a curated, licensed guideline corpus.

### Running the workflow

1. Install L1 dependencies and copy the environment template:

   ```bash
   npm install
   cp .env.example .env
   # Edit .env with your own API keys and MCP bridge URL.
   ```

2. Install L2/L3 Python dependencies:

   ```bash
   cd clinical_rag_system
   python -m venv .venv
   source .venv/bin/activate  # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```

3. Start the services (see `docs/MCP_STARTUP_GUIDE.md` for details):

   ```bash
   # Terminal 1: LightRAG L3 server
   python clinical_rag_system/start_lightrag_custom.py

   # Terminal 2: MCP HTTP bridge
   python clinical_rag_system/mcp_http_bridge.py

   # Terminal 3: Vite dev server
   npm run dev
   ```

A working LightRAG index over an appropriately licensed guideline corpus is required to
run the L3 retrieval layer; the corpus and its index are not included in this repository.

## Privacy and governance

Before any public release or update, verify that:

- `.env`, `.env.*`, `config/.env`, and `config/lightrag.env` remain excluded from version control;
- no chart-derived source materials, full case vignettes, full generated reports, raw
  clinician score sheets, clinician-identifying metadata, or restricted guideline full
  text are included;
- code, manuscript-supporting documentation, aggregate tables, aggregate figures,
  packaging utilities, and non-PHI reproducibility metadata are the only study materials
  made public;
- any model/run metadata shared publicly is limited to non-secret scientific metadata.

## Inputs

Scripts expect pseudonymized aggregate CSVs from the controlled study dataset.
Row-level ratings and source records are not included in this repository.
