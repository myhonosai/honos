import type { Metadata } from 'next';
import './globals.css';
import { readLocaleContext } from '../server/locale-context';
import { LocaleProvider } from '../components/localization/provider';
import { LocaleUtility } from '../components/localization/utility';

export const metadata: Metadata = {
  title: 'HON | School Operations',
  description: 'The operating system for martial arts schools.',
  icons: {
    icon: '/manus-storage/async-images/V2i1yOxmOLQ5wsG9Ltutn8/image-1.webp',
  },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await readLocaleContext();
  return (
    <html lang={locale.preferences.language}>
      <body><LocaleProvider key={locale.scope ?? 'public'} scope={locale.scope} initial={locale.preferences}><LocaleUtility/>{children}</LocaleProvider></body>
    </html>
  );
}
