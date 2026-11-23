'use client';

import { useEffect } from 'react';
import { reportClientError } from '@/lib/client-log';
import './globals.css';

/** Last-resort boundary for errors in the root layout itself. Renders its own html/body. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError(error, { boundary: 'global' });
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-white p-6 text-black">
        <div role="alert" className="max-w-md rounded-lg border border-black p-6">
          <h1 className="text-lg font-semibold">AI Workforce is unavailable</h1>
          <p className="mt-2 text-sm text-gray-600">
            An unexpected error stopped the app from loading. Try again in a moment.
          </p>
          {error.digest && (
            <p className="mt-3 font-mono text-xs text-gray-600">
              Error ID <span className="select-all text-black">{error.digest}</span>
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            className="mt-5 h-9 rounded-md bg-black px-4 text-sm font-medium text-white hover:bg-gray-600"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
