import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'HON | Family Journey',
  robots: { index: false, follow: false },
};

export default function ParentPage(): never {
  redirect('/parent/journey');
}
