import React from 'react';
import { HomeLanding } from '../components/home/home-landing';

export const metadata = {
  title: 'HON OS | Sign in',
  description: 'HON OS, the AI-powered operating system built to run and grow martial arts schools.',
  robots: { index: false, follow: false },
};

/** Public entry point: no sample data, no school or account information, only the ways in. */
export default function HomePage(): React.ReactElement {
  return <HomeLanding />;
}
