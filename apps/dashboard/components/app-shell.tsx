'use client';

import { Bot, Building2, LayoutDashboard, ListChecks, Menu, Settings, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/organization', label: 'Organization', icon: Building2 },
  { href: '/employees', label: 'AI employees', icon: Bot },
  { href: '/tasks', label: 'Tasks', icon: ListChecks },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const;

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              active ? 'bg-black text-white' : 'text-black hover:bg-gray-100',
            )}
          >
            <Icon className="size-4" aria-hidden strokeWidth={1.75} />
            {label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:bg-white focus:px-3 focus:py-2"
      >
        Skip to content
      </a>

      <aside className="hidden w-60 shrink-0 border-r border-gray-300 px-4 py-6 md:block">
        <Brand />
        <div className="mt-8">{nav}</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-gray-300 px-4 md:hidden">
          <Brand />
          <button
            type="button"
            className="rounded-md p-2 hover:bg-gray-100"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </header>
        {open && <div className="border-b border-gray-300 px-4 py-3 md:hidden">{nav}</div>}

        <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-10 md:py-10">
          {children}
        </main>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
      <span
        className="flex size-6 items-center justify-center rounded bg-black text-xs text-white"
        aria-hidden
      >
        AI
      </span>
      Workforce
    </Link>
  );
}
