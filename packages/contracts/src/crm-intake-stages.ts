import type { CommandContext } from './index.js';

/** Deliberately small fixed cap: intake offers choices, never a pipeline directory. */
export const CRM_INTAKE_STAGES_MAXIMUM = 25;

/** Direct human/current-school context for an existing create-capable CRM intake choice read. */
export interface CrmIntakeStagesReadContext extends CommandContext {
  externalSubject: string;
}

/** The only configured pipeline facts a normal lead-intake selector needs. */
export interface CrmIntakeStage {
  pipelineId: string;
  pipelineName: string;
  stageId: string;
  stageName: string;
}

function invalid(): never { throw new Error('The CRM intake-stage result could not be verified. No stage is selected.'); }
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) invalid();
  return record;
}
export function crmIntakeStageUuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) invalid();
  return value.toLowerCase();
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 160
    || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value)) invalid();
  return value;
}

/**
 * Accepts only the configured non-terminal pipeline/stage identifiers and
 * names needed for an explicit intake selection. No lead, contact, status,
 * source, automation, provider, AI, metric, or history data is allowed.
 */
export function verifyCrmIntakeStages(value: unknown): CrmIntakeStage[] {
  if (!Array.isArray(value) || value.length > CRM_INTAKE_STAGES_MAXIMUM) invalid();
  const stageIds = new Set<string>();
  let priorPipelineName: string | undefined;
  return value.map((value) => {
    const item = closed(value, ['pipelineId', 'pipelineName', 'stageId', 'stageName']);
    const pipelineId = crmIntakeStageUuid(item.pipelineId);
    const pipelineName = name(item.pipelineName);
    const stageId = crmIntakeStageUuid(item.stageId);
    const stageName = name(item.stageName);
    // The server fixes the finer stage-position order but intentionally omits
    // position from this intake-only projection. The observable pipeline-name
    // grouping remains deterministic without inventing a hidden sort fact.
    const normalizedPipelineName = pipelineName.toLocaleLowerCase('en-US');
    if (stageIds.has(stageId) || (priorPipelineName !== undefined && normalizedPipelineName < priorPipelineName)) invalid();
    stageIds.add(stageId); priorPipelineName = normalizedPipelineName;
    return { pipelineId, pipelineName, stageId, stageName };
  });
}
