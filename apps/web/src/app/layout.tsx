import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'HON | School Operations',
  description: 'The operating system for martial arts schools.',
  icons: {
    icon: '/manus-storage/async-images/V2i1yOxmOLQ5wsG9Ltutn8/image-1.webp',
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
