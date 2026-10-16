import { closedLibraryObject,isCurriculumLibraryId,verifyStaffCurriculumLibrary,verifyParentCurriculumLibrary,verifyCurriculumResourceRecord,type CurriculumResourceCreateInput,type CurriculumResourceUpdateInput,type CurriculumResourceArchiveInput } from '@hon/contracts';
export class LibraryUiError extends Error { constructor(message:string,readonly status:number) {super(message);} }
async function request(path:string,body?:object,key?:string,signal?:AbortSignal,parent=false) {
 const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:signal??null,
 headers:{Accept:'application/json',...(body?{'Content-Type':'application/json','X-Hon-Human-Command':'curriculum-library','Idempotency-Key':key??''}:{})},...(body?{body:JSON.stringify(body)}:{})});
 if(!response.ok) throw new LibraryUiError('Current library access or version could not be verified. No success is assumed; retain the unchanged retry key or refresh current versions.',response.status);
 if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')) throw new Error('Library response could not be verified.');
 const envelope=closedLibraryObject(await response.json(),['data','meta']);
 const meta=closedLibraryObject(envelope.meta,parent?['requestId','correlationId']:['requestId','correlationId','replayed']);
 if(!isCurriculumLibraryId(meta.requestId)||meta.requestId!==meta.correlationId||(!parent&&typeof meta.replayed!=='boolean')) throw new Error('Library response could not be verified.');
 return envelope.data;
}
function staffPath(school:string) {if(!isCurriculumLibraryId(school))throw new Error('Enter one already-known school UUID.');return `/api/v1/staff/schools/${school}/curriculum-library`;}
export async function loadStaffLibrary(school:string,signal?:AbortSignal) {return verifyStaffCurriculumLibrary(await request(staffPath(school),undefined,undefined,signal));}
export async function createLibraryReference(school:string,input:CurriculumResourceCreateInput,key:string) {return verifyCurriculumResourceRecord(await request(staffPath(school),input,key));}
export async function updateLibraryReference(school:string,id:string,input:CurriculumResourceUpdateInput,key:string) {if(!isCurriculumLibraryId(id))throw new Error('Invalid reference.');return verifyCurriculumResourceRecord(await request(`${staffPath(school)}/${id}/versions`,input,key));}
export async function archiveLibraryReference(school:string,id:string,input:CurriculumResourceArchiveInput,key:string) {if(!isCurriculumLibraryId(id))throw new Error('Invalid reference.');return verifyCurriculumResourceRecord(await request(`${staffPath(school)}/${id}/archive`,input,key));}
/** No client organization, school, family, student, child or resource selector. */
export async function loadParentLibrary(signal?:AbortSignal) {return verifyParentCurriculumLibrary(await request('/api/v1/parent/curriculum-library',undefined,undefined,signal,true));}
