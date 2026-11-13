import React from 'react';
import { requireVerifiedWebSession } from '../../../server/require-web-session';
import { HqContactSettings } from '../../../components/hq-contact/hq-contact';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON OS | Texts from HON', robots: { index: false, follow: false }, referrer: 'no-referrer' };
export default async function TextsFromHonPage(): Promise<React.ReactElement> { await requireVerifiedWebSession(); return <HqContactSettings/>; }
