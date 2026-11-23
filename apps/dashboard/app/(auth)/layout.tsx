import type { ReactNode } from 'react';

/** Sign-in and first-run setup: centered, no navigation. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-start justify-center px-4 py-16 sm:items-center sm:py-0">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2 font-semibold tracking-tight">
          <span
            className="flex size-6 items-center justify-center rounded bg-black text-xs text-white"
            aria-hidden
          >
            AI
          </span>
          Workforce
        </div>
        {children}
      </div>
    </main>
  );
}
