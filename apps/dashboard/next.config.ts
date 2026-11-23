import type { NextConfig } from 'next';

const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  // Browser calls go to /api/v1/* on the dashboard's own origin and are proxied to the
  // web process, so no CORS is needed and the API address stays server-side.
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${apiUrl}/v1/:path*` }];
  },
};

export default nextConfig;
