import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { validateTrialPolicyProposalInput,validateTrialPolicyDecisionInput,validateTrialCampaignDraftInput,validateTrialCampaignPublishInput,validateTrialCampaignWithdrawInput,
 validateTrialGovernanceView,validateTrialCampaignView,validateTrialPublicationPreview,validateTrialPolicyReceipt,validateTrialDecisionReceipt,validateTrialDraftReceipt,validateTrialPublicationReceipt,saasUuid } from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';
const parse=<T>(fn:()=>T):T=>{try{return fn();}catch{throw new BadRequestException({code:'INVALID_SAAS_INPUT'});}};
@Injectable()
export class SaasTrialsService {
 constructor(private readonly billing:SaasBillingService){}
 read(subject:string){return this.billing.call('readTrialGovernance',[subject],validateTrialGovernanceView);}
 campaign(subject:string,id:unknown){return this.billing.call('readTrialCampaign',[subject,parse(()=>saasUuid(id))],validateTrialCampaignView);}
 preview(subject:string,id:unknown){return this.billing.call('previewTrialPublication',[subject,parse(()=>saasUuid(id))],validateTrialPublicationPreview);}
 propose(subject:string,body:unknown,key:unknown){const [p,k]=parse(()=>[validateTrialPolicyProposalInput(body),saasUuid(key)] as const);return this.billing.call('proposeTrialPolicy',[subject,JSON.stringify(p),k,randomUUID(),randomUUID()],validateTrialPolicyReceipt);}
 decide(subject:string,body:unknown,key:unknown){const [p,k]=parse(()=>[validateTrialPolicyDecisionInput(body),saasUuid(key)] as const);return this.billing.call('decideTrialPolicy',[subject,JSON.stringify(p),k,randomUUID(),randomUUID()],validateTrialDecisionReceipt);}
 draft(subject:string,body:unknown,key:unknown){const [p,k]=parse(()=>[validateTrialCampaignDraftInput(body),saasUuid(key)] as const);return this.billing.call('draftTrialCampaign',[subject,JSON.stringify(p),k,randomUUID(),randomUUID()],validateTrialDraftReceipt);}
 publish(subject:string,id:unknown,body:unknown,key:unknown){const [campaign,p,k]=parse(()=>[saasUuid(id),validateTrialCampaignPublishInput(body),saasUuid(key)] as const);return this.billing.call('publishTrialCampaign',[subject,campaign,JSON.stringify(p),k,randomUUID(),randomUUID()],validateTrialPublicationReceipt);}
 withdraw(subject:string,id:unknown,body:unknown,key:unknown){const [campaign,p,k]=parse(()=>[saasUuid(id),validateTrialCampaignWithdrawInput(body),saasUuid(key)] as const);return this.billing.call('withdrawTrialCampaign',[subject,campaign,JSON.stringify(p),k,randomUUID(),randomUUID()],validateTrialPublicationReceipt);}
}
