import React from 'react';
import { ClassSessionWorkbench } from '../../../../../components/class-session-workbench';
// The shared staff layout verifies the signed session; every submit/replay also
// independently verifies direct-human transport and exact current-school scope.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Human Class-session Creation', robots: { index: false, follow: false } };
export default function StaffClassSessionCreatePage() {
  return <ClassSessionWorkbench />;
}
