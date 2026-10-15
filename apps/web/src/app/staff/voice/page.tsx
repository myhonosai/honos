import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import { VoiceWorkspace } from '../../../components/voice-workspace';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Complete Voice Handoff', robots: { index: false, follow: false } };
export default async function VoicePage() {
  let authenticated = false;
  try { const token = (await cookies()).get(HON_SESSION_COOKIE)?.value; if (token) { verifySession(token, sessionConfig()); authenticated=true; } } catch { /* fail closed */ }
  if (!authenticated) redirect('/auth/login');
  return <VoiceWorkspace/>;
}
