// MCP Clinical Guidelines Service
// This service enhances prompts with clinical guideline context
// It uses the AI model itself to retrieve and incorporate guidelines

export async function enhanceWithGuidelines(
  medicalRecord: string,
  clinicalPhase: ClinicalPhase
): Promise<string> {
  // Build the guideline query based on clinical phase and case
  const guidelineQuery = `
Based on the following medical case, identify 2-3 most relevant clinical guidelines:

Case:
${medicalRecord}

Clinical Phase: ${clinicalPhase}

List:
1. Guideline name and source
2. 2-3 key recommendations relevant to this case
3. Evidence level

Format as:
GUIDELINES:
[Relevant guidelines with key points]`;

  return guidelineQuery;
}

// Extract guidelines from AI response
export function parseGuidelines(aiResponse: string): string {
  const match = aiResponse.match(/GUIDELINES:\\n([\\s\\S]*?)(?:\\n\\n|$)/);
  return match ? match[1].trim() : '';
}

// Build enhanced prompt with guidelines
export function buildEnhancedPrompt(
  basePrompt: string,
  medicalRecord: string,
  guidelinesContext: string
): string {
  return `${basePrompt}

RELEVANT CLINICAL GUIDELINES:
${guidelinesContext}

MEDICAL RECORD:
${medicalRecord}

INSTRUCTIONS:
- Follow the above clinical guidelines where applicable
- Cite specific guideline recommendations
- Assign evidence levels to your recommendations

Remember: Return ONLY valid JSON, NO explanatory text.`;
}
