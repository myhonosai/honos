import React from 'react';
import { CurriculumProgressWorkbench } from '../../../../components/curriculum-progress-workbench';

// The shared staff layout verifies the session; every API read/submit/replay
// independently rechecks current human, school permission and entitlement.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Human Curriculum Progress', robots: { index: false, follow: false } };
export default function StaffCurriculumProgressPage() {
  return <CurriculumProgressWorkbench />;
}
