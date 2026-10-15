import { Allow } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import { CURRICULUM_PROGRESS_STATUSES, CURRICULUM_REQUIREMENT_KINDS } from '@hon/contracts';
import type { CreateCurriculumRequirementInput, UpdateCurriculumRequirementInput, EnrollStudentCurriculumInput, SetStudentCurriculumRankInput, RecordCurriculumProgressInput } from '@hon/contracts';
export class CreateCurriculumRequirementDto implements CreateCurriculumRequirementInput {
 @Allow() declare code: string; @Allow() declare kind: CreateCurriculumRequirementInput['kind']; @Allow() declare definition: CreateCurriculumRequirementInput['definition']; @Allow() declare required: boolean;
}
export class UpdateCurriculumRequirementDto extends CreateCurriculumRequirementDto implements UpdateCurriculumRequirementInput { @Allow() declare expectedVersion: number }
export class EnrollStudentCurriculumDto implements EnrollStudentCurriculumInput { @Allow() declare studentProfileId: string; @Allow() declare currentRankId: string|null }
export class SetStudentCurriculumRankDto implements SetStudentCurriculumRankInput { @Allow() declare currentRankId: string|null; @Allow() declare expectedEnrollmentVersion: number }
export class RecordCurriculumProgressDto implements RecordCurriculumProgressInput {
 @Allow() declare requirementId: string; @Allow() declare expectedRequirementVersion: number; @Allow() declare expectedEnrollmentVersion: number; @Allow() declare expectedProgressVersion: number;
 @Allow() declare status: RecordCurriculumProgressInput['status']; @Allow() declare instructorNote?: string;
}
export function invalid(): never { throw new BadRequestException({code:'VALIDATION_FAILED',detail:'Invalid closed curriculum command. Use bounded explicit values and current versions.'}); }
export function uuid(v: unknown): asserts v is string { if(typeof v!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) invalid(); }
function closed(v: unknown,keys: readonly string[]): asserts v is Record<string,unknown> { if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))) invalid(); }
function version(v: unknown,min=1): void { if(!Number.isSafeInteger(v)||(v as number)<min||(v as number)>999999999) invalid(); }
export type CurriculumOperation = 'REQUIREMENT_CREATE'|'REQUIREMENT_UPDATE'|'ENROLL'|'SET_RANK'|'OBSERVE';
export function validateCurriculumInput(operation: CurriculumOperation,input: unknown): void {
 if(operation==='REQUIREMENT_CREATE'||operation==='REQUIREMENT_UPDATE') {
  closed(input,['code','kind','definition','required',...(operation==='REQUIREMENT_UPDATE'?['expectedVersion']:[])]);
  if(typeof input.code!=='string'||! /^[A-Z][A-Z0-9_]{0,63}$/.test(input.code)||!CURRICULUM_REQUIREMENT_KINDS.includes(input.kind as never)||typeof input.required!=='boolean') invalid();
  closed(input.definition,['label','description']);
  const {label,description}=input.definition;
  if(typeof label!=='string'||!label.trim()||label.length>160||/[\u0000-\u001f\u007f]/.test(label)) invalid();
  if(description!==undefined&&(typeof description!=='string'||description.length>2000)) invalid();
  if(operation==='REQUIREMENT_UPDATE') version(input.expectedVersion);
 } else if(operation==='ENROLL'||operation==='SET_RANK') {
  closed(input,operation==='ENROLL'?['studentProfileId','currentRankId']:['currentRankId','expectedEnrollmentVersion']);
  if(!('currentRankId' in input)) invalid(); if(input.currentRankId!==null) uuid(input.currentRankId);
  if(operation==='ENROLL') uuid(input.studentProfileId); else version(input.expectedEnrollmentVersion);
 } else if(operation==='OBSERVE') {
  closed(input,['requirementId','expectedRequirementVersion','expectedEnrollmentVersion','expectedProgressVersion','status','instructorNote']);
  uuid(input.requirementId); version(input.expectedRequirementVersion); version(input.expectedEnrollmentVersion); version(input.expectedProgressVersion,0);
  if(!CURRICULUM_PROGRESS_STATUSES.includes(input.status as never)||input.instructorNote!==undefined&&(typeof input.instructorNote!=='string'||input.instructorNote.length>2000)) invalid();
 } else invalid();
}
