import type {SaasHonOsOfferSet,SaasHonOsOfferSetDetail,SaasHonOsOfferManagementView,SaasHonOsOfferSetDraftInput} from '@hon/contracts';
export function syntheticSetInput():SaasHonOsOfferSetDraftInput;
export function createOfferFixtures():{sets:Map<string,SaasHonOsOfferSet>;originalId:string;draftId:string;detail:(id:string)=>SaasHonOsOfferSetDetail;management:()=>SaasHonOsOfferManagementView;command:(kind:string,target:string|null,body:unknown,key:string,subject?:string)=>any;readonly mutations:number};
