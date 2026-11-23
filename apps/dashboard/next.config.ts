import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

export default function config(phase: string): NextConfig {
  return {
    // The dev server gets its own output folder, so running `next build` (CI checks,
    // `pnpm build`) while `pnpm dev` is up can't delete the dev server's CSS and chunks.
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next',
    output: 'standalone',
    poweredByHeader: false,
    reactStrictMode: true,
    // Browser calls go to /api/v1/* on the dashboard's own origin and are proxied to the
    // web process, so no CORS is needed and the API address stays server-side.
    async rewrites() {
      return [{ source: '/api/v1/:path*', destination: `${apiUrl}/v1/:path*` }];
    },
  };
}
