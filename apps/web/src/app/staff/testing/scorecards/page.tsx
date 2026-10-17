import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import { TestingScorecardWorkbench } from '../../../../components/testing-scorecard-workbench';
import { testingScorecardInitialIds } from '../../../../components/testing-scorecard-handoff';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Human testing scorecards', robots: { index: false, follow: false } };

type StaffTestingScorecardsPageProps = { searchParams: Promise<Record<string, unknown>> };

export default async function StaffTestingScorecardsPage({ searchParams }: StaffTestingScorecardsPageProps) {
  let authenticated = false;
  try {
    const value = (await cookies()).get(HON_SESSION_COOKIE)?.value;
    authenticated = Boolean(value && verifySession(value, sessionConfig(process.env)));
  } catch { /* fail closed */ }
  if (!authenticated) redirect('/auth/login');
  const query = await searchParams;
  return <TestingScorecardWorkbench initialKnownIds={testingScorecardInitialIds(query)} />;
}
