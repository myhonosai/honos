import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import { OwnerLaunch } from '../../../components/owner-launch';
export const dynamic='force-dynamic';
export const metadata={title:'HON | Owner launch',description:'Verified human school launch and saved receipts.',referrer:'no-referrer',robots:{index:false,follow:false}};
export default async function OwnerLaunchPage() {
  let authenticated=false;
  try {const token=(await cookies()).get(HON_SESSION_COOKIE)?.value;if(token){verifySession(token,sessionConfig());authenticated=true;}} catch { /* fail closed */ }
  if(!authenticated)redirect('/auth/login');
  return <OwnerLaunch />;
}
