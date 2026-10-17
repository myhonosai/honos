import React from 'react';
import { ClassSessionsRead } from '../../../../components/class-sessions-read';

// The staff layout requires the signed session; browser/API/database checks then
// independently establish direct human current-school read authority.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Bounded Class Sessions', robots: { index: false, follow: false } };
export default function StaffClassSessionsPage() { return <ClassSessionsRead />; }
