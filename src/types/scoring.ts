// Scoring system interfaces

import type { TokenUsage } from './report'

export interface DimensionScores {
  accuracy: number;
  completeness: number;
  safety: number;
  clarity: number;
}

export interface ReviewJustification {
  accuracy: string;
  completeness: string;
  safety: string;
  clarity: string;
}

export interface PeerReview {
  targetModelId: string;
  targetModelName: string;
  evaluatorModelId: string;
  evaluatorModelName: string;
  scores: DimensionScores;
  weightedOverallScore: number;
  justification: ReviewJustification;
  fatalFlag: boolean;
  tokenUsage?: TokenUsage;
}

export interface ScoringMatrix {
  [reportModelId: string]: {
    [evaluatorModelId: string]: PeerReview;
  };
}
