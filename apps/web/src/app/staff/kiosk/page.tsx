import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import { KioskWorkbench } from '../../../components/kiosk-workbench';
export const dynamic='force-dynamic';
export const metadata={title:'HON | Human Kiosk Handoff',robots:{index:false,follow:false},referrer:'no-referrer' as const};
export default async function StaffKioskPage() {
 let authenticated=false;
 try {const token=(await cookies()).get(HON_SESSION_COOKIE)?.value;if(token){verifySession(token,sessionConfig());authenticated=true;}}catch{/* fail closed */}
 if(!authenticated)redirect('/auth/login');
 return <KioskWorkbench />;
}
