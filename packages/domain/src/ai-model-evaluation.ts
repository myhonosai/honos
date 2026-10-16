import {
  AI_MODEL_EVALUATION_TASK_CATEGORIES,
  AI_MODEL_EVALUATION_WEIGHTS,
  AI_PROVIDER_IDS,
  type AiModelEvaluationCandidate,
  type AiModelEvaluationCandidateResult,
  type AiModelEvaluationFixture,
  type AiModelEvaluationObservation,
  type AiModelEvaluationReport,
  type EvaluateAiModelCandidatesInput,
} from '@hon/contracts';
import { AI_MODEL_EVALUATION_FIXTURE_MANIFEST } from '@hon/config';

const SAFE_CANDIDATE_ID = /^[a-z][a-z0-9-]{2,63}$/;
const UNSAFE_REPORTABLE_TEXT = /(?:secret|credential|token|password|prompt|output|tenant|permission|tool|authority|route|action|api[-_]?key|private[-_]?key|auth|https?:|(?:sk|pk)[-_]|AIza|bearer|[A-Za-z0-9_-]{32,})/i;
const MAX_CANDIDATES = 16;
const MAX_LATENCY_MS = 300_000;
const MAX_COST_MICROUNITS = 1_000_000_000;
const APPROVED_FIXTURES = new Map(AI_MODEL_EVALUATION_FIXTURE_MANIFEST.map((item) => [item.fixtureId, item.taskCategory]));

function fail(): never {
  throw new Error('VALIDATION_FAILED');
}

function safeCandidateId(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_CANDIDATE_ID.test(value) || UNSAFE_REPORTABLE_TEXT.test(value)) fail();
  return value;
}

function safeFixtureId(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_CANDIDATE_ID.test(value) || UNSAFE_REPORTABLE_TEXT.test(value) || !APPROVED_FIXTURES.has(value)) fail();
  return value;
}

function whole(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail();
  return value;
}

function score(value: unknown): number {
  return whole(value, 0, 100);
}

function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') fail();
  return value;
}

function candidate(value: unknown): AiModelEvaluationCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== 2 || !Object.hasOwn(object, 'candidateId') || !Object.hasOwn(object, 'providerId')) fail();
  const providerId = object.providerId;
  if (typeof providerId !== 'string' || !AI_PROVIDER_IDS.includes(providerId as (typeof AI_PROVIDER_IDS)[number])) fail();
  return { candidateId: safeCandidateId(object.candidateId), providerId: providerId as AiModelEvaluationCandidate['providerId'] };
}

function fixture(value: unknown): AiModelEvaluationFixture {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== 2 || !Object.hasOwn(object, 'fixtureId') || !Object.hasOwn(object, 'taskCategory')) fail();
  const taskCategory = object.taskCategory;
  if (typeof taskCategory !== 'string' || !AI_MODEL_EVALUATION_TASK_CATEGORIES.includes(taskCategory as (typeof AI_MODEL_EVALUATION_TASK_CATEGORIES)[number])) fail();
  const fixtureId = safeFixtureId(object.fixtureId);
  if (APPROVED_FIXTURES.get(fixtureId) !== taskCategory) fail();
  return { fixtureId, taskCategory: taskCategory as AiModelEvaluationFixture['taskCategory'] };
}

function observation(value: unknown): AiModelEvaluationObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const object = value as Record<string, unknown>;
  const keys = ['candidateId', 'fixtureId', 'answerQualityScore', 'instructionFollowingScore', 'latencyMs', 'estimatedCostMicrounits', 'structuredOutputValid', 'permissionCompliant', 'hallucinationObserved', 'appropriateEscalation', 'repeatConsistent'];
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key))) fail();
  return {
    candidateId: safeCandidateId(object.candidateId),
    fixtureId: safeFixtureId(object.fixtureId),
    answerQualityScore: score(object.answerQualityScore),
    instructionFollowingScore: score(object.instructionFollowingScore),
    latencyMs: whole(object.latencyMs, 1, MAX_LATENCY_MS),
    estimatedCostMicrounits: whole(object.estimatedCostMicrounits, 0, MAX_COST_MICROUNITS),
    structuredOutputValid: flag(object.structuredOutputValid),
    permissionCompliant: flag(object.permissionCompliant),
    hallucinationObserved: flag(object.hallucinationObserved),
    appropriateEscalation: flag(object.appropriateEscalation),
    repeatConsistent: flag(object.repeatConsistent),
  };
}

function average(values: readonly number[]): number {
  if (!values.length) fail();
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Each faster or cheaper candidate is normalized against the same fixture set. */
function relativeScore(value: number, best: number): number {
  if (value === 0 && best === 0) return 100;
  if (value === 0) return 100;
  return Math.min(100, (best / value) * 100);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Scores a fully supplied local/mock evaluation matrix. No network, provider
 * request, HQ write, action proposal, work item, credit, or model assignment
 * is possible from this pure evaluator.
 */
export function evaluateAiModelCandidates(input: EvaluateAiModelCandidatesInput): AiModelEvaluationReport {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const object = input as unknown as Record<string, unknown>;
  if (Object.keys(object).length !== 3 || !Object.hasOwn(object, 'candidates') || !Object.hasOwn(object, 'fixtures') || !Object.hasOwn(object, 'observations')
    || !Array.isArray(object.candidates) || !Array.isArray(object.fixtures) || !Array.isArray(object.observations)) fail();
  if (object.candidates.length < 2 || object.candidates.length > MAX_CANDIDATES || object.fixtures.length !== APPROVED_FIXTURES.size) fail();

  const candidates = object.candidates.map(candidate);
  const fixtures = object.fixtures.map(fixture);
  const observations = object.observations.map(observation);
  if (new Set(candidates.map((item) => item.candidateId)).size !== candidates.length
    || new Set(fixtures.map((item) => item.fixtureId)).size !== fixtures.length) fail();
  if (fixtures.some((item) => APPROVED_FIXTURES.get(item.fixtureId) !== item.taskCategory)
    || fixtures.some((item) => !APPROVED_FIXTURES.has(item.fixtureId))) fail();

  const expectedPairs = new Set(candidates.flatMap((item) => fixtures.map((test) => `${item.candidateId}\u0000${test.fixtureId}`)));
  if (observations.length !== expectedPairs.size) fail();
  const observedPairs = new Set<string>();
  for (const item of observations) {
    const pair = `${item.candidateId}\u0000${item.fixtureId}`;
    if (!expectedPairs.has(pair) || observedPairs.has(pair)) fail();
    observedPairs.add(pair);
  }
  if (observedPairs.size !== expectedPairs.size) fail();

  const byCandidate = new Map(candidates.map((item) => [item.candidateId, observations.filter((result) => result.candidateId === item.candidateId)]));
  const bestLatency = Math.min(...candidates.map((item) => average(byCandidate.get(item.candidateId)!.map((result) => result.latencyMs))));
  const bestCost = Math.min(...candidates.map((item) => average(byCandidate.get(item.candidateId)!.map((result) => result.estimatedCostMicrounits))));

  const weights = Object.freeze({ ...AI_MODEL_EVALUATION_WEIGHTS });
  const rankings: AiModelEvaluationCandidateResult[] = candidates.map((item) => {
    const results = byCandidate.get(item.candidateId)!;
    const failedFixtureIds = results.filter((result) => !result.structuredOutputValid || !result.permissionCompliant || result.hallucinationObserved || !result.appropriateEscalation || !result.repeatConsistent).map((result) => result.fixtureId).sort();
    const quality = average(results.map((result) => result.answerQualityScore));
    const reliability = average(results.flatMap((result) => [result.instructionFollowingScore, result.permissionCompliant ? 100 : 0, result.hallucinationObserved ? 0 : 100, result.appropriateEscalation ? 100 : 0, result.repeatConsistent ? 100 : 0]));
    const structuredOutput = average(results.map((result) => result.structuredOutputValid ? 100 : 0));
    const speed = relativeScore(average(results.map((result) => result.latencyMs)), bestLatency);
    const cost = relativeScore(average(results.map((result) => result.estimatedCostMicrounits)), bestCost);
    const weightedScore = (quality * weights.QUALITY
      + reliability * weights.RELIABILITY
      + structuredOutput * weights.STRUCTURED_OUTPUT
      + speed * weights.SPEED
      + cost * weights.COST) / 100;
    return Object.freeze({
      candidate: Object.freeze({ ...item }),
      scores: Object.freeze({ quality: round(quality), reliability: round(reliability), structuredOutput: round(structuredOutput), speed: round(speed), cost: round(cost) }),
      weightedScore: round(weightedScore),
      safetyGatesPassed: failedFixtureIds.length === 0,
      failedFixtureIds: Object.freeze([...failedFixtureIds]),
      eligibleForOwnerReview: failedFixtureIds.length === 0,
    });
  }).sort((left, right) => (Number(right.safetyGatesPassed) - Number(left.safetyGatesPassed)) || (right.weightedScore - left.weightedScore) || left.candidate.candidateId.localeCompare(right.candidate.candidateId));

  return Object.freeze({
    contractVersion: 1,
    execution: 'LOCAL_OR_MOCK_ONLY',
    productionAssignment: 'NOT_PERFORMED',
    weights,
    evaluatedFixtureIds: Object.freeze(fixtures.map((item) => item.fixtureId).sort()),
    rankings: Object.freeze([...rankings]),
  });
}
