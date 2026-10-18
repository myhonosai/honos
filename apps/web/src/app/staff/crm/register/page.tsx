import React from 'react';
import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { HON_SESSION_COOKIE } from '@hon/auth';
import { CrmLeadRegistrationWorkbench } from '../../../../components/crm-lead-registration-workbench';
export const dynamic='force-dynamic';
export const metadata={robots:{index:false,follow:false}};
type Props={searchParams:Promise<{leadId?:string}>};
function lead(value:unknown):string|undefined{return typeof value==='string'&&value.length<=80?value:undefined;}
export default async function CrmLeadRegistrationPage({searchParams}:Props){const query=await searchParams;const token=(await cookies()).get(HON_SESSION_COOKIE)?.value??'';const key=createHash('sha256').update(token).digest('hex');const initialLeadId=lead(query.leadId);return <CrmLeadRegistrationWorkbench key={key} {...(initialLeadId===undefined?{}:{initialLeadId})} />;}
