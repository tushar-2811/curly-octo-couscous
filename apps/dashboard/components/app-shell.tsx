'use client';

import {
  Bot,
  Building2,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  ScrollText,
  Settings,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { clientFetch } from '@/lib/client-api';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/organization', label: 'Organization', icon: Building2 },
  { href: '/people', label: 'People', icon: Users },
  { href: '/employees', label: 'AI employees', icon: Bot },
  { href: '/tasks', label: 'Tasks', icon: ListChecks },
  { href: '/audit', label: 'Audit log', icon: ScrollText, auditorsOnly: true },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const;

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({
  children,
  orgName,
  user,
  canAudit,
}: {
  children: ReactNode;
  orgName: string;
  user: { name: string; email: string };
  /** Admins and security admins see the audit log. */
  canAudit: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {NAV.filter((item) => canAudit || !('auditorsOnly' in item)).map(
        ({ href, label, icon: Icon }) => {
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
        },
      )}
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

      <aside className="hidden w-60 shrink-0 flex-col border-r border-gray-300 px-4 py-6 md:flex">
        <Brand />
        <p className="mt-1 truncate pl-8 text-xs text-gray-600" title={orgName}>
          {orgName}
        </p>
        <div className="mt-8 flex-1">{nav}</div>
        <UserFooter user={user} />
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
        {open && (
          <div className="border-b border-gray-300 px-4 py-3 md:hidden">
            {nav}
            <div className="mt-4">
              <UserFooter user={user} />
            </div>
          </div>
        )}

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

function UserFooter({ user }: { user: { name: string; email: string } }) {
  const [pending, setPending] = useState(false);
  async function signOut() {
    setPending(true);
    try {
      await clientFetch('/v1/auth/logout', { method: 'POST' });
    } finally {
      // Leave even if the request failed: the cookie expires on its own.
      window.location.assign('/sign-in');
    }
  }
  return (
    <div className="border-t border-gray-300 pt-4">
      <p className="truncate text-sm font-medium" title={user.name}>
        {user.name}
      </p>
      <p className="truncate text-xs text-gray-600" title={user.email}>
        {user.email}
      </p>
      <button
        type="button"
        onClick={signOut}
        disabled={pending}
        className="mt-3 flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-gray-100 disabled:opacity-50"
      >
        <LogOut className="size-4" aria-hidden strokeWidth={1.75} />
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
