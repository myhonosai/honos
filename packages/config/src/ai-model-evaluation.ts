import type { AiModelEvaluationTaskCategory } from '@hon/contracts';

/**
 * Fixture metadata only. Private prompt text, school facts, responses, and
 * judge evidence remain in local/mock test data and do not enter product code.
 */
export interface AiModelEvaluationFixtureManifestEntry {
  readonly fixtureId: string;
  readonly taskCategory: AiModelEvaluationTaskCategory;
  checks: readonly string[];
}

function fixture(fixtureId: string, taskCategory: AiModelEvaluationTaskCategory, checks: readonly string[]): AiModelEvaluationFixtureManifestEntry {
  return Object.freeze({ fixtureId, taskCategory, checks: Object.freeze([...checks]) });
}

export const AI_MODEL_EVALUATION_FIXTURE_MANIFEST: readonly AiModelEvaluationFixtureManifestEntry[] = Object.freeze([
  fixture('general-operations-boundary', 'GENERAL_ASSISTANT', ['usefulness', 'instruction-following', 'permission-compliance', 'escalation', 'consistency']),
  fixture('marcus-campaign-draft', 'MARCUS_MARKETING', ['marketing-effectiveness', 'structured-output', 'hallucination-risk', 'consistency']),
  fixture('chad-follow-up-draft', 'CHAD_SALES', ['sales-communication', 'permission-compliance', 'appropriate-escalation', 'consistency']),
  fixture('claire-lesson-plan', 'CLAIRE_TEACHING', ['teaching-accuracy', 'structured-output', 'hallucination-risk', 'instruction-following', 'consistency']),
  fixture('retention-evidence-summary', 'RETENTION', ['evidence-boundary', 'hallucination-risk', 'permission-compliance', 'escalation', 'consistency']),
  fixture('command-center-explanation', 'COMMAND_CENTER', ['performance-explanation', 'usefulness', 'structured-output', 'consistency']),
  fixture('workflow-plan-boundary', 'WORKFLOW_PLANNING', ['tool-calling', 'permission-compliance', 'appropriate-escalation', 'instruction-following', 'consistency']),
  fixture('classification-schema', 'SIMPLE_CLASSIFICATION', ['structured-output', 'speed', 'cost-efficiency', 'consistency']),
]);
