// Clinical phase definitions

export enum ClinicalPhase {
  OUTPATIENT = 'outpatient',
  INPATIENT = 'inpatient',
  DISCHARGE = 'discharge'
}

export enum PromptMode {
  OUTPATIENT = 'outpatient',
  INPATIENT = 'inpatient',
  DISCHARGE = 'discharge'
}

export interface PhaseConfig {
  id: ClinicalPhase;
  name: string;
  description: string;
}

// Phase-specific content extensions
export interface OutpatientContent {
  diagnosticConclusion: string;
  decisionLogic: string;
  treatmentPlan: string;
  disclaimer: string;
}

export interface InpatientContent {
  responseEvaluation: string;
  surgicalPlan: string;
  keyConcerns: string;
  disclaimer: string;
}

export interface DischargeContent {
  finalDiagnosis: string;
  adjuvantPlan: string;
  prognosisEvaluation: string;
  disclaimer: string;
}
