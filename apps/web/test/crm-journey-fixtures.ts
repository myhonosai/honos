export const id = (n:number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const scope = {organizationId:id(1),schoolId:id(2)};
export const row = {id:id(3),primaryPersonId:id(4),pipelineStageId:id(5),version:1,status:'OPEN' as const,givenName:'Private',familyName:'Canary',email:'private@example.test',createdAt:'2026-10-30T12:00:00.000Z'};
export const envelope = (data:unknown,status=200) => new Response(JSON.stringify({data,meta:{requestId:id(9),correlationId:id(9),replayed:false}}),{status,headers:{'Content-Type':'application/json','Cache-Control':'private, no-store'}});
export const identity = (subject='staff:synthetic') => new Response(JSON.stringify({data:{externalSubject:subject}}),{headers:{'Content-Type':'application/json','Cache-Control':'private, no-store'}});
export const queue = {schoolId:id(2),principalId:id(6),canManage:false,humanOnly:true,queue:'mine',status:'ALL',items:[],nextAfter:null};
export const closeReceipt = (status='WON') => ({...scope,leadId:row.id,status,priorVersion:1,version:2,closedAt:'2026-10-30T12:00:01.000Z',closeNote:null,crmOnly:true});
export const appointment = (start='2026-11-02T09:00:00.000Z',end='2026-11-02T10:00:00.000Z') => ({id:id(8),crmLeadId:row.id,appointmentType:'TRIAL',status:'SCHEDULED',startsAt:start,endsAt:end,createdByPrincipalId:id(6),version:1,createdAt:'2026-10-30T12:00:00.000Z',updatedAt:'2026-10-30T12:00:00.000Z'});
