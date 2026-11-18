import type { Metadata } from 'next';
import { People } from '../../../components/people/people';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | People', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The verified subject lets the card's family access section re-check that the same account is still signed in. */
export default async function PeoplePage() { const identity = await requireVerifiedWebSession(); return <People sessionSubject={identity.externalSubject}/>; }
