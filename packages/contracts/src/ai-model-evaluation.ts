import type { AiProviderId } from './ai-provider.js';

/**
 * These dimensions are for offline/mock comparison only. They neither select a
 * production model nor grant routing, provider, Action Engine, or tool access.
 */
export const AI_MODEL_EVALUATION_DIMENSIONS = Object.freeze([
  'QUALITY',
  'RELIABILITY',
  'STRUCTURED_OUTPUT',
  'SPEED',
  'COST',
] as const);
export type AiModelEvaluationDimension = (typeof AI_MODEL_EVALUATION_DIMENSIONS)[number];

export const AI_MODEL_EVALUATION_TASK_CATEGORIES = Object.freeze([
  'GENERAL_ASSISTANT',
  'MARCUS_MARKETING',
  'CHAD_SALES',
  'CLAIRE_TEACHING',
  'RETENTION',
  'COMMAND_CENTER',
  'WORKFLOW_PLANNING',
  'SIMPLE_CLASSIFICATION',
  // R1 (0287) routing categories: HON Standard/Detailed, Claire business performance, Kai teaching.
  'HON_STANDARD',
  'HON_DETAILED',
  'BUSINESS_PERFORMANCE',
  'KAI_TEACHING',
] as const);
export type AiModelEvaluationTaskCategory = (typeof AI_MODEL_EVALUATION_TASK_CATEGORIES)[number];

/** The approved initial comparison weights total 100 and are code-visible. */
export const AI_MODEL_EVALUATION_WEIGHTS: Readonly<Record<AiModelEvaluationDimension, number>> = Object.freeze({
  QUALITY: 35,
  RELIABILITY: 25,
  STRUCTURED_OUTPUT: 20,
  SPEED: 10,
  COST: 10,
});

/** Candidate identity supplied to the local evaluator; it is not an HQ catalog entry. */
export interface AiModelEvaluationCandidate {
  readonly candidateId: string;
  readonly providerId: AiProviderId;
}

/**
 * A fixture's prompt/content stays in local test data and never crosses this
 * contract. The evaluator receives only a stable safe fixture ID and category.
 */
export interface AiModelEvaluationFixture {
  readonly fixtureId: string;
  readonly taskCategory: AiModelEvaluationTaskCategory;
}

/**
 * A local/mock judge supplies scalar scores and explicit safety gates. Raw
 * prompts, model output, credentials, tenant data, tools, or authority fields
 * are intentionally absent.
 */
export interface AiModelEvaluationObservation {
  candidateId: string;
  fixtureId: string;
  answerQualityScore: number;
  instructionFollowingScore: number;
  latencyMs: number;
  estimatedCostMicrounits: number;
  structuredOutputValid: boolean;
  permissionCompliant: boolean;
  hallucinationObserved: boolean;
  appropriateEscalation: boolean;
  repeatConsistent: boolean;
}

export interface EvaluateAiModelCandidatesInput {
  candidates: AiModelEvaluationCandidate[];
  fixtures: AiModelEvaluationFixture[];
  observations: AiModelEvaluationObservation[];
}

export interface AiModelEvaluationDimensionScores {
  readonly quality: number;
  readonly reliability: number;
  readonly structuredOutput: number;
  readonly speed: number;
  readonly cost: number;
}

export interface AiModelEvaluationCandidateResult {
  readonly candidate: AiModelEvaluationCandidate;
  readonly scores: AiModelEvaluationDimensionScores;
  readonly weightedScore: number;
  readonly safetyGatesPassed: boolean;
  readonly failedFixtureIds: readonly string[];
  readonly eligibleForOwnerReview: boolean;
}

/**
 * A deterministic local comparison report. It is evidence for human/HQ review,
 * never a production routing decision, provider request, or model assignment.
 */
export interface AiModelEvaluationReport {
  readonly contractVersion: 1;
  readonly execution: 'LOCAL_OR_MOCK_ONLY';
  readonly productionAssignment: 'NOT_PERFORMED';
  readonly weights: Readonly<Record<AiModelEvaluationDimension, number>>;
  readonly evaluatedFixtureIds: readonly string[];
  readonly rankings: readonly AiModelEvaluationCandidateResult[];
}
