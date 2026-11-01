import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { A2P_ENGINE_VERSION, A2P_PERMISSION, A2P_FACT_CONFIRMATION, validateA2pWebsiteReview, validateA2pDraftInput, validateA2pFindingInput,
  validateA2pCopyInput, a2pText, type A2pSchoolScope, type A2pWebsiteResponse, type A2pFindingResponse,
  type A2pDraftResponse, type A2pValidationResponse, type A2pCopyResponse } from '@hon/contracts';
import { evaluateA2pWebsite, generateA2pDraft } from '@hon/domain';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { A2P_WEBSITE_INSPECTOR, type A2pWebsiteInspector } from './a2p-inspector.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value === 'object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value);
}
function digest(scope: A2pSchoolScope, input: unknown): string {
  return createHash('sha256').update(canonical({ engineVersion: A2P_ENGINE_VERSION, scope, input })).digest('hex');
}
@Injectable()
export class A2pPreparationService {
  constructor(private readonly database: RuntimeDatabaseService,
    @Inject(A2P_WEBSITE_INSPECTOR) private readonly inspector: A2pWebsiteInspector) {}
  private async scope(subject: string, organizationId: string, schoolId: string): Promise<A2pSchoolScope> {
    try {
      const selected = await this.database.resolveAuthorizedScope(subject,schoolId,A2P_PERMISSION);
      if (!selected || selected.organizationId!==organizationId || selected.schoolId!==schoolId) throw new ForbiddenException({code:'A2P_PREPARATION_FORBIDDEN'});
      const result = await this.database.readA2pPreparationScope({ ...selected, externalSubject:subject, principalType:'HUMAN_USER', requestId:randomUUID() });
      if (!result || result.organizationId!==organizationId || result.schoolId!==schoolId || result.principalId!==selected.principalId) throw new ForbiddenException({code:'A2P_PREPARATION_FORBIDDEN'});
      if(typeof result.canConfirmOwnerFacts!=='boolean')throw new Error('INVALID_A2P_SCOPE');
      return Object.freeze({ organizationId, schoolId, schoolName:a2pText(result.schoolName,200), canConfirmOwnerFacts:result.canConfirmOwnerFacts });
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      if ((error as {code?:string})?.code==='42501') throw new ForbiddenException({code:'A2P_PREPARATION_FORBIDDEN'});
      throw new ServiceUnavailableException({code:'A2P_PREPARATION_UNAVAILABLE'});
    }
  }
  private input<T>(parse:()=>T):T {
    try { return parse(); } catch(error) {
      const code=(error as Error).message;
      throw new BadRequestException({code:['A2P_URL_NOT_ALLOWED','A2P_CAMPAIGN_MISMATCH'].includes(code)?code:'INVALID_A2P_INPUT'});
    }
  }
  async website(subject:string,org:string,school:string,value:unknown):Promise<A2pWebsiteResponse> {
    const scope=await this.scope(subject,org,school),input=this.input(()=>validateA2pWebsiteReview(value));
    let inspection;
    try { inspection=await this.inspector.inspect(input); } catch { inspection={kind:'UNAVAILABLE' as const,reason:'INSPECTION_FAILED' as const}; }
    let review;
    try { review=evaluateA2pWebsite(inspection); } catch { review=evaluateA2pWebsite({kind:'UNAVAILABLE',reason:'INSPECTION_FAILED'}); }
    const current=await this.scope(subject,org,school);
    if (current.schoolName!==scope.schoolName) throw new ConflictException({code:'A2P_SCHOOL_CHANGED'});
    return Object.freeze({scope:current,review,computationDigest:digest(current,input),readOnly:true as const,persistence:'NONE' as const});
  }
  async finding(subject:string,org:string,school:string,value:unknown):Promise<A2pFindingResponse> {
    const input=this.input(()=>validateA2pFindingInput(value));
    const result=await this.website(subject,org,school,input.review);
    return Object.freeze({scope:result.scope,finding:result.review.findings.find(f=>f.code===input.findingCode)!,sources:result.review.sources,readOnly:true as const,persistence:'NONE' as const});
  }
  async draft(subject:string,org:string,school:string,value:unknown):Promise<A2pDraftResponse> {
    const scope=await this.scope(subject,org,school),input=this.input(()=>validateA2pDraftInput(value));
    if(input.ownerConfirmation===A2P_FACT_CONFIRMATION&&!scope.canConfirmOwnerFacts)throw new ForbiddenException({code:'A2P_OWNER_FACT_CONFIRMATION_REQUIRED'});
    const draft=generateA2pDraft(input,scope.schoolName),current=await this.scope(subject,org,school);
    if(input.ownerConfirmation===A2P_FACT_CONFIRMATION&&!current.canConfirmOwnerFacts)throw new ForbiddenException({code:'A2P_OWNER_FACT_CONFIRMATION_REQUIRED'});
    if (current.schoolName!==scope.schoolName) throw new ConflictException({code:'A2P_SCHOOL_CHANGED'});
    return Object.freeze({scope:current,draft,computationDigest:digest(current,input),readOnly:true as const,persistence:'NONE' as const});
  }
  async validate(subject:string,org:string,school:string,value:unknown):Promise<A2pValidationResponse> {
    const result=await this.draft(subject,org,school,value);
    return Object.freeze({...result,validation:Object.freeze({readyForCopyPreparation:result.draft.copyPreparationAvailable,
      missingFields:result.draft.missingFields,warnings:result.draft.warnings,providerEligibility:'NOT_VERIFIED' as const,approval:'NOT_REQUESTED' as const})});
  }
  async copy(subject:string,org:string,school:string,value:unknown):Promise<A2pCopyResponse> {
    const input=this.input(()=>validateA2pCopyInput(value)),result=await this.draft(subject,org,school,input.input);
    if (input.expectedDigest!==result.computationDigest) throw new ConflictException({code:'A2P_DRAFT_CHANGED'});
    if (!result.draft.copyPreparationAvailable || !result.draft.answers) throw new ConflictException({code:'A2P_DRAFT_INCOMPLETE'});
    const d=result.draft;
    const content=['HON OS A2P draft — external owner review required. Not saved, submitted, legally approved or sent.',
      'Twilio brand/use-case eligibility and actual website/consent behavior must be checked separately.',
      ...Object.entries(d.answers!).map(([key,text])=>key+': '+text),
      ...d.sampleMessages.map((s,i)=>`Sample ${i+1} (${s.template}): ${s.content}`),
      'Proposed HELP response (not configured): '+d.helpResponseSample,
      'Proposed STOP response (not configured): '+d.stopResponseSample,
      'Review warnings: '+d.warnings.join(', ')].join('\n\n');
    return Object.freeze({scope:result.scope,computationDigest:result.computationDigest,format:'TEXT' as const,
      filename:'hon-a2p-draft.txt',content,readOnly:true as const,persistence:'NONE' as const,submitted:false as const,messagesSent:0 as const});
  }
}
