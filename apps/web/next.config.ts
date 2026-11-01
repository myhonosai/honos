import type { NextConfig } from 'next';
import { assertWebStartupConfiguration } from './src/server/web-startup';

const nextConfig: NextConfig = {
  transpilePackages: ['@hon/design-system'],
  async rewrites() {
    const apiBaseUrl = (process.env.HON_API_BASE_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
    return [{ source: '/api/v1/:path*', destination: `${apiBaseUrl}/v1/:path*` }];
  },
};

export default function configureNext(phase: string): NextConfig {
  assertWebStartupConfiguration(phase);
  return nextConfig;
}
