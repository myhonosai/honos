import { reportConfirmedSessionInvalidation } from '../session-invalidation';
export class AccountError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
export async function accountRequest(path: string, signal: AbortSignal, command?: Readonly<{body: object; key: string}>) {
  const response=await fetch('/api/v1/'+path,{method:command?'POST':'GET',credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),
    headers:{Accept:'application/json',...(command?{'Content-Type':'application/json','X-HON-Human-Command':'school-owner-account','Idempotency-Key':command.key}:{})},...(command?{body:JSON.stringify(command.body)}:{})});
  if(response.status===401) reportConfirmedSessionInvalidation();
  const root: unknown=await response.json().catch(()=>null);
  if(!response.ok) { const code=root&&typeof root==='object'&&'code' in root&&typeof root.code==='string'?root.code:'ACCOUNT_UNAVAILABLE'; throw new AccountError(response.status,code); }
  if(!root||typeof root!=='object'||Array.isArray(root)||Object.keys(root).length!==1||!Object.hasOwn(root,'data')) throw new AccountError(503,'ACCOUNT_RESPONSE_INVALID');
  return (root as {data:unknown}).data;
}
