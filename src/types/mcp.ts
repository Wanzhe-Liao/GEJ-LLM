// MCP clinical guidelines interface

export interface ClinicalGuideline {
  guidelineId: string;
  source: string;
  specialty: string;
  conditions: string[];
  recommendations: GuidelineRecommendation[];
  evidenceLevel: 'A' | 'B' | 'C';
  relevance: number; // 0-1, calculated based on case match
}

export interface GuidelineRecommendation {
  text: string;
  strength: 'strong' | 'weak';
  rationale: string;
}

export interface MCPQueryResult {
  guidelines: ClinicalGuideline[];
  context: string; // Formatted context for prompt injection
}
