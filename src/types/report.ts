// Core report interfaces

import type { ClinicalPhase, OutpatientContent, InpatientContent, DischargeContent } from './phase'

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface KeyQuestion {
  question: string;
  evidence: string;
  analysis: string;
}

export interface DifferentialDiagnosis {
  diagnosis: string;
  supportingEvidence: string;
  opposingEvidence: string;
  likelihood: 'high' | 'moderate' | 'low';
}

export interface ReasoningProcess {
  keyQuestions: KeyQuestion[];
  differentialDiagnosis: DifferentialDiagnosis[];
}

export interface BaseReportContent {
  caseSummary: string;
  reasoningProcess: ReasoningProcess;
  conclusion: string;
  recommendations: string[];
  disclaimer: string;
}

// Report with clinical phase
export type PhaseReportContent =
  | OutpatientContent
  | InpatientContent
  | DischargeContent;

export interface Report {
  modelId: string;
  modelName: string;
  content: PhaseReportContent | null;
  streamContent?: string;
  error?: string;
  tokenUsage?: TokenUsage;
  phase: ClinicalPhase;
}

export interface OptimizedReport extends Report {
  baselineScore?: number;
  optimizedScore?: number;
  improvement?: number;

  citations?: Array<{
    guidelineName: string;
    source?: string;
    quote?: string;
    appliedTo?: string;
    evidenceLevel?: string;
  }>;

  changeLog?: Array<{
    field: string;
    statementId?: string;
    changeType: 'retained' | 'modified' | 'added';
    original: string;
    optimized: string;
    classification: string;
    guidelineEvidence: string;
    evidenceTier?: string;
    resolutionRule?: string;
    clinicalRationale?: string;
  }>;

  qualityMetrics?: {
    totalStatements?: number;
    retainedStatements?: number;
    substantiveChanges: number;
    guidelinesCited: number;
    conflictsResolved?: number;
    clinicalImpact?: 'high' | 'medium' | 'low';
    similarity?: number;
  };

  reasoningTrace?: string;
}
