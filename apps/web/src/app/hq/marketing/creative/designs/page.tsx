import type { Metadata } from 'next';
import { HqDesigns } from '../../../../../components/hq-creative/hq-designs';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Designs', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the HQ designs API decides HQ marketing access on every read and command. */
export default function HqDesignsPage(): React.ReactElement { return <HqDesigns/>; }
