import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AI_MODEL_EVALUATION_WEIGHTS, AI_PROVIDER_IDS } from '@hon/contracts';
import { AI_MODEL_EVALUATION_FIXTURE_MANIFEST } from '@hon/config';
import { evaluateAiModelCandidates } from '../src/index.js';

const candidates = [
  { candidateId: 'luna-evaluation', providerId: 'OPENROUTER' as const },
  { candidateId: 'gemini-evaluation', providerId: 'OPENROUTER' as const },
];
const fixtures = AI_MODEL_EVALUATION_FIXTURE_MANIFEST.map(({ fixtureId, taskCategory }) => ({ fixtureId, taskCategory }));
const safeObservation = (candidateId: string, fixtureId: string, answerQualityScore: number, instructionFollowingScore: number, latencyMs: number, estimatedCostMicrounits: number) => ({
  candidateId,
  fixtureId,
  answerQualityScore,
  instructionFollowingScore,
  latencyMs,
  estimatedCostMicrounits,
  structuredOutputValid: true,
  permissionCompliant: true,
  hallucinationObserved: false,
  appropriateEscalation: true,
  repeatConsistent: true,
});
const matrix = () => ({
  candidates,
  fixtures,
  observations: [
    ...fixtures.map((fixture, index) => safeObservation('luna-evaluation', fixture.fixtureId, 81, 95, 100 + index, 10)),
    ...fixtures.map((fixture, index) => safeObservation('gemini-evaluation', fixture.fixtureId, 93, 89, 220 + index, 20)),
  ],
});

function result(report: ReturnType<typeof evaluateAiModelCandidates>, candidateId: string) {
  return report.rankings.find((item) => item.candidate.candidateId === candidateId)!;
}

describe('local/mock AI model evaluation', () => {
  it('registers privacy-safe representative coverage for every approved HON task category and required check', () => {
    expect(Object.isFrozen(AI_MODEL_EVALUATION_FIXTURE_MANIFEST)).toBe(true);
    expect(Object.isFrozen(AI_PROVIDER_IDS)).toBe(true);
    expect(() => { (AI_MODEL_EVALUATION_FIXTURE_MANIFEST as unknown as unknown[]).push({}); }).toThrow();
    expect(() => { (AI_PROVIDER_IDS as unknown as string[]).push('ARBITRARY'); }).toThrow();
    expect(AI_MODEL_EVALUATION_FIXTURE_MANIFEST.map((item) => item.taskCategory)).toEqual([
      'GENERAL_ASSISTANT', 'MARCUS_MARKETING', 'CHAD_SALES', 'CLAIRE_TEACHING',
      'RETENTION', 'COMMAND_CENTER', 'WORKFLOW_PLANNING', 'SIMPLE_CLASSIFICATION',
    ]);
    const checks = AI_MODEL_EVALUATION_FIXTURE_MANIFEST.flatMap((item) => item.checks);
    expect(checks).toEqual(expect.arrayContaining(['marketing-effectiveness', 'sales-communication', 'teaching-accuracy', 'permission-compliance', 'hallucination-risk', 'escalation', 'consistency']));
    for (const item of AI_MODEL_EVALUATION_FIXTURE_MANIFEST) {
      expect(Object.isFrozen(item)).toBe(true);
      expect(Object.isFrozen(item.checks)).toBe(true);
      expect(item.fixtureId).toMatch(/^[a-z0-9-]+$/);
      expect(item.checks).toContain('consistency');
      expect(Object.keys(item)).toEqual(['fixtureId', 'taskCategory', 'checks']);
      expect(item.checks.join(' ')).not.toMatch(/credential|secret|token|password|prompt/i);
    }
  });

  it('uses frozen 35/25/20/10/10 weights and creates an isolated immutable report snapshot', () => {
    expect(AI_MODEL_EVALUATION_WEIGHTS).toEqual({ QUALITY: 35, RELIABILITY: 25, STRUCTURED_OUTPUT: 20, SPEED: 10, COST: 10 });
    expect(Object.isFrozen(AI_MODEL_EVALUATION_WEIGHTS)).toBe(true);
    const input = matrix();
    const before = JSON.stringify(input);
    const report = evaluateAiModelCandidates(input);
    expect(report).toEqual(evaluateAiModelCandidates(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(report).toMatchObject({ contractVersion: 1, execution: 'LOCAL_OR_MOCK_ONLY', productionAssignment: 'NOT_PERFORMED', evaluatedFixtureIds: fixtures.map((item) => item.fixtureId).sort() });
    expect(report.rankings.map((item) => item.candidate.candidateId)).toEqual(['luna-evaluation', 'gemini-evaluation']);
    expect(report.rankings[0]).toMatchObject({ safetyGatesPassed: true, eligibleForOwnerReview: true, failedFixtureIds: [], scores: { quality: 81, reliability: 99, structuredOutput: 100, speed: 100, cost: 100 }, weightedScore: 93.1 });
    expect(JSON.stringify(report)).not.toMatch(/modelId|AKIA|AIza|credential|secret/i);
    expect(report.weights).not.toBe(AI_MODEL_EVALUATION_WEIGHTS);
    expect(Object.isFrozen(report.weights)).toBe(true);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.evaluatedFixtureIds)).toBe(true);
    expect(Object.isFrozen(report.rankings)).toBe(true);
    expect(Object.isFrozen(report.rankings[0])).toBe(true);
    expect(Object.isFrozen(report.rankings[0]!.candidate)).toBe(true);
    expect(Object.isFrozen(report.rankings[0]!.scores)).toBe(true);
    expect(Object.isFrozen(report.rankings[0]!.failedFixtureIds)).toBe(true);
    expect(() => { (report.weights as unknown as Record<string, number>).QUALITY = 0; }).toThrow();
    expect(() => { (report as unknown as { productionAssignment: string }).productionAssignment = 'ASSIGNED'; }).toThrow();
    expect(() => { (report.rankings[0] as unknown as { safetyGatesPassed: boolean }).safetyGatesPassed = false; }).toThrow();
    expect(() => { (report.rankings[0]!.failedFixtureIds as unknown as string[]).push('forged'); }).toThrow();
    expect(evaluateAiModelCandidates(matrix()).weights.QUALITY).toBe(35);
  });

  it('rejects every individual unsafe structured-output, permission, hallucination, escalation, and consistency gate', () => {
    const fixtureId = fixtures[0]!.fixtureId;
    for (const gate of [
      { structuredOutputValid: false },
      { permissionCompliant: false },
      { hallucinationObserved: true },
      { appropriateEscalation: false },
      { repeatConsistent: false },
    ]) {
      const input = matrix();
      Object.assign(input.observations.find((item) => item.candidateId === 'gemini-evaluation' && item.fixtureId === fixtureId)!, gate);
      const rejected = result(evaluateAiModelCandidates(input), 'gemini-evaluation');
      expect(rejected).toMatchObject({ safetyGatesPassed: false, eligibleForOwnerReview: false, failedFixtureIds: [fixtureId] });
    }
  });

  it('requires the exact approved fixture manifest and a complete same-fixture candidate matrix', () => {
    const input = matrix();
    for (const patch of [
      { fixtures: fixtures.slice(1) },
      { fixtures: [...fixtures.slice(0, -1), { fixtureId: fixtures[0]!.fixtureId, taskCategory: 'MARCUS_MARKETING' }] },
      { observations: input.observations.slice(1) },
      { observations: [...input.observations, input.observations[0]] },
    ]) expect(() => evaluateAiModelCandidates({ ...input, ...patch } as never)).toThrow('VALIDATION_FAILED');
  });

  it('rejects unsafe reportable identifiers and forbidden candidate/provider/authority payloads at the allowed fields', () => {
    const input = matrix();
    for (const candidateId of ['tenant-acme', 'prompt-fragment', 'authority-auto', 'sk-live-example', 'api-key-reference', 'private-key-reference', 'auth-reference']) {
      expect(() => evaluateAiModelCandidates({ ...input, candidates: [{ ...candidates[0], candidateId }, candidates[1]] })).toThrow('VALIDATION_FAILED');
    }
    for (const modelId of ['https://unapproved.example', 'output-customer-data', 'tenant-school-42', 'prompt-exfiltration', 'sk-live-example', 'AIzaExample', 'api-key-reference', 'private-key-reference', 'auth-reference', 'AKIAIOSFODNN7EXAMPLE', 'abcdeabcdeabcdeabcde.abcdeabcdeabcdeabcde']) {
      expect(() => evaluateAiModelCandidates({ ...input, candidates: [{ ...candidates[0], modelId }, candidates[1]] } as never)).toThrow('VALIDATION_FAILED');
    }
    for (const patch of [
      { candidates: [{ ...candidates[0], providerId: 'ARBITRARY' }, candidates[1]] },
      { candidates: [{ ...candidates[0], credentialSecretRef: 'hon-secret:11111111-1111-4111-8111-111111111111' }, candidates[1]] },
      { authorityMode: 'AUTO' },
      { fixtures: [{ ...fixtures[0], prompt: 'private content' }, ...fixtures.slice(1)] },
    ]) expect(() => evaluateAiModelCandidates({ ...input, ...patch } as never)).toThrow('VALIDATION_FAILED');
  });

  it('contains no provider, network, route, or Action Engine integration path', () => {
    const network = vi.fn(() => { throw new Error('network forbidden'); });
    vi.stubGlobal('fetch', network);
    try {
      expect(() => evaluateAiModelCandidates(matrix())).not.toThrow();
      expect(network).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
    const source = readFileSync('src/ai-model-evaluation.ts', 'utf8');
    expect(source).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|spawn|exec|decideAiRoute|validateAiControlPlaneWrite|authorizeAction)\b/);
    expect(source).not.toMatch(/@hon\/(?:database|api|auth)/);
  });
});
