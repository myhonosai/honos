export type PreviewProfile = Readonly<{label:string;plane:'hq'|'school';organizationId?:string;schoolId?:string;schoolName?:string}>;
export const id:(n:number)=>string;
export const PROFILES:Readonly<Record<'hq'|'schoolA'|'schoolB',PreviewProfile>>;
export function createPreviewFixtures(): {
  dispatch(input:{profile:PreviewProfile;subject:string;method:string;path:string;headers?:Record<string,string>;body?:unknown}):{status:number;body:{data:unknown;meta?:{requestId:string;correlationId:string;replayed:boolean}}};
  stats():{syntheticEffects:number;providerCalls:number;financialEffects:number};
  directory():unknown;
};
