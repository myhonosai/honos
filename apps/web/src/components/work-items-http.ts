import { HUMAN_WORK_UUID, HUMAN_WORK_STATUSES, validateHumanWork, validateHumanWorkDue, type HumanWorkInput, type HumanWorkTransition, type HumanWorkOperation, type HumanWorkQueueItem, type HumanWorkRecord, type HumanWorkQueue, type HumanWorkStatus } from '@hon/contracts';
const base = '/api/v1/staff/work';
export const workFingerprint = (v: unknown): string => JSON.stringify(v,(_,x: unknown) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a],[b]) => a.localeCompare(b))) : x);
export class WorkAccessError extends Error {}
function invalid(): never { throw new Error('Unverified result. No save assumed. Retry unchanged with the retained key or reload current records.'); }
function closed(v: unknown,keys: string[]): asserts v is Record<string,unknown> { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v,k))) invalid(); }
function uuid(v: unknown): asserts v is string { if (typeof v !== 'string' || !HUMAN_WORK_UUID.test(v)) invalid(); }
function time(v: unknown) { if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) invalid(); }
function version(v: unknown) { if (!Number.isSafeInteger(v) || Number(v)<1 || Number(v)>999999999) invalid(); }
function item(v: unknown): HumanWorkQueueItem {
  closed(v,['title','workItemId','version','status','priority','dueAt','assigneeId']);
  validateHumanWork('CREATE',{expectedVersion:0,title:v.title,description:'',priority:v.priority,dueAt:v.dueAt,assigneeId:v.assigneeId}); uuid(v.workItemId); version(v.version);
  if (v.assigneeId !== null) uuid(v.assigneeId);
  if (!(HUMAN_WORK_STATUSES as readonly unknown[]).includes(v.status) || !['LOW','NORMAL','HIGH'].includes(String(v.priority))) invalid();
  validateHumanWorkDue(v.dueAt); return v as unknown as HumanWorkQueueItem;
}
function record(v: unknown): HumanWorkRecord {
  closed(v,['workItemId','schoolId','version','status','title','description','priority','dueAt','assigneeId','createdBy','createdAt','updatedAt','humanOnly','executionAllowed','canEdit','canTransition','aiPlanIds','history','nextBeforeVersion']);
  uuid(v.schoolId); uuid(v.createdBy); time(v.createdAt); time(v.updatedAt);
  item(Object.fromEntries(['title','workItemId','version','status','priority','dueAt','assigneeId'].map(k => [k,v[k]])));
  validateHumanWork('CREATE',{expectedVersion:0,title:v.title,description:v.description,priority:v.priority,dueAt:v.dueAt,assigneeId:v.assigneeId});
  if (v.humanOnly !== true || v.executionAllowed !== false || typeof v.canEdit !== 'boolean' || typeof v.canTransition !== 'boolean' || !Array.isArray(v.aiPlanIds) || v.aiPlanIds.length>20 || new Set(v.aiPlanIds).size !== v.aiPlanIds.length || !Array.isArray(v.history) || v.history.length>50) invalid();
  v.aiPlanIds.forEach(uuid);
  let prior=Number(v.version)+1;
  for(const h of v.history) {
    closed(h,['version','operation','status','assigneeId','actorId','recordedAt']); version(h.version); uuid(h.actorId); time(h.recordedAt); if(h.assigneeId !== null) uuid(h.assigneeId);
    if(Number(h.version)>=prior || !['CREATE','UPDATE','TRANSITION'].includes(String(h.operation)) || !(HUMAN_WORK_STATUSES as readonly unknown[]).includes(h.status)) invalid(); prior=Number(h.version);
  }
  if(v.nextBeforeVersion !== null) { version(v.nextBeforeVersion); if(v.history.length!==50 || v.nextBeforeVersion !== prior) invalid(); }
  if(['COMPLETED','FAILED'].includes(String(v.status)) && (v.canEdit || v.canTransition)) invalid();
  return v as unknown as HumanWorkRecord;
}
async function request(path: string,body?: HumanWorkInput|HumanWorkTransition,key?: string): Promise<unknown> {
  const response=await fetch(base+path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json','X-HON-Human-Command':'human-work','Idempotency-Key':key!}:{},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok) throw new (response.status===401 || response.status===403 ? WorkAccessError:Error)(response.status===401 ? 'Sign in with a verified human staff session.' : response.status===403 ? 'Current exact school permission or assignment is unavailable. Reload after access is restored.' : response.status===404 ? 'Human work is unavailable in this school or assignment scope.' : response.status===409 ? 'Version, lifecycle or retry conflict. Reload current records before changing input.' : 'No verified result. Retry unchanged with the retained key; check bounded fields.');
  const envelope: unknown=await response.json(); const data=(envelope as {data?:unknown})?.data; if(!data) invalid(); return data;
}
export async function loadHumanWork(queue:'mine'|'team',status:HumanWorkStatus|'ACTIVE'|'ALL',after:string|null=null):Promise<HumanWorkQueue> {
  if(!['mine','team'].includes(queue) || ![...HUMAN_WORK_STATUSES,'ACTIVE','ALL'].includes(status)) invalid(); if(after!==null) uuid(after);
  const v=await request(`?queue=${queue}&status=${status}${after?`&after=${after}`:''}`);
  closed(v,['schoolId','principalId','canManage','canCreate','humanOnly','executionAllowed','queue','status','items','nextAfter']); uuid(v.schoolId); uuid(v.principalId);
  if(v.humanOnly!==true || v.executionAllowed!==false || typeof v.canManage!=='boolean' || typeof v.canCreate!=='boolean' || v.queue!==queue || v.status!==status || (queue==='team' && !v.canManage) || !Array.isArray(v.items) || v.items.length>50) invalid();
  let prior=after?.toLowerCase()??null;
  for(const x of v.items){ const r=item(x); if((prior && r.workItemId<=prior) || (status==='ACTIVE' && ['COMPLETED','FAILED'].includes(r.status)) || (!['ACTIVE','ALL'].includes(status) && r.status!==status)) invalid(); prior=r.workItemId; }
  if(v.nextAfter!==null){ uuid(v.nextAfter); if(v.items.length!==50 || v.nextAfter!==prior) invalid(); }
  return v as unknown as HumanWorkQueue;
}
export async function readHumanWork(id:string,beforeVersion:number|null=null):Promise<HumanWorkRecord> {
  uuid(id); if(beforeVersion!==null && (!Number.isSafeInteger(beforeVersion) || beforeVersion<2 || beforeVersion>999999999)) invalid();
  const r=record(await request(`/${id}${beforeVersion!==null?`?beforeVersion=${beforeVersion}`:''}`)); if(r.workItemId!==id.toLowerCase() || (beforeVersion!==null && r.history.some(h=>h.version>=beforeVersion))) invalid(); return r;
}
export async function mutateHumanWork(op:HumanWorkOperation,id:string|null,input:HumanWorkInput|HumanWorkTransition,key:string):Promise<HumanWorkRecord> {
  if(id!==null) uuid(id); validateHumanWork(op,input);
  if((op==='CREATE')!==(id===null) || typeof key!=='string' || !key || key.length>200 || key.trim()!==key || /[\u0000-\u001f\u007f]/.test(key)) invalid();
  const path=op==='CREATE'?'':op==='UPDATE'?`/${id}/revisions`:`/${id}/transition`;
  const r=record(await request(path,input,key));
  if((id && r.workItemId!==id.toLowerCase()) || r.version!==input.expectedVersion+1 || (op==='CREATE' && r.status!=='READY') || ('targetStatus' in input && r.status!==input.targetStatus)) invalid();
  if('title' in input && workFingerprint({title:r.title,description:r.description,priority:r.priority,dueAt:r.dueAt,assigneeId:r.assigneeId})!==workFingerprint({...input,assigneeId:input.assigneeId?.toLowerCase()??null,expectedVersion:undefined})) invalid();
  return r;
}
