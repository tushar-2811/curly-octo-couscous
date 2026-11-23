import { AlertTriangle, Inbox, Loader2, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The three non-data states every view must handle. Monochrome: the state is carried by
 * the icon, the wording and the border style (dashed for empty, solid black for error).
 */

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center rounded-lg border border-dashed border-gray-300 px-6 py-12 text-center',
        className,
      )}
    >
      <Icon className="size-6" aria-hidden strokeWidth={1.5} />
      <h3 className="mt-3 text-sm font-semibold">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-gray-600">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title,
  description,
  requestId,
  digest,
  action,
  className,
}: {
  title: string;
  description?: string;
  /** Shown so users can quote it and engineers can find the matching log lines. */
  requestId?: string;
  digest?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div role="alert" className={cn('rounded-lg border border-black px-5 py-4', className)}>
      <div className="flex gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && <p className="mt-1 text-sm text-gray-600">{description}</p>}
          {(requestId || digest) && (
            <dl className="mt-3 space-y-0.5 font-mono text-xs text-gray-600">
              {requestId && (
                <div className="flex gap-2">
                  <dt>Request ID</dt>
                  <dd className="select-all break-all text-black">{requestId}</dd>
                </div>
              )}
              {digest && (
                <div className="flex gap-2">
                  <dt>Error ID</dt>
                  <dd className="select-all break-all text-black">{digest}</dd>
                </div>
              )}
            </dl>
          )}
          {action && <div className="mt-4">{action}</div>}
        </div>
      </div>
    </div>
  );
}

export function LoadingState({
  label = 'Loading',
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('flex items-center gap-2 text-sm text-gray-600', className)}
    >
      <Loader2 className="size-4 animate-spin" aria-hidden />
      <span>{label}…</span>
    </div>
  );
}
