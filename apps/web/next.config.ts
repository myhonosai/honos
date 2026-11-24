import type { NextConfig } from 'next';
import { assertWebStartupConfiguration } from './src/server/web-startup';

const nextConfig: NextConfig = {
  transpilePackages: ['@hon/design-system'],
  async rewrites() {
    const apiBaseUrl = (process.env.HON_API_BASE_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
    return [
      { source: '/api/v1/:path*', destination: `${apiBaseUrl}/v1/:path*` },
      // 0628: the stable picture link used in emails and on the media screen; the API answers with a short-lived redirect.
      { source: '/m/:token', destination: `${apiBaseUrl}/v1/public/media/:token` },
    ];
  },
};

export default function configureNext(phase: string): NextConfig {
  assertWebStartupConfiguration(phase);
  return nextConfig;
}
