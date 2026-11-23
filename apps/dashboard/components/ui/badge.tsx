import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Small outlined label. `solid` for emphasis, `danger` (red) for errors and failures. */
export function Badge({
  children,
  variant = 'outline',
  className,
}: {
  children: ReactNode;
  variant?: 'outline' | 'solid' | 'muted' | 'danger';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium leading-none',
        variant === 'outline' && 'border-black',
        variant === 'solid' && 'border-black bg-black text-white',
        variant === 'muted' && 'border-gray-300 text-gray-600',
        variant === 'danger' && 'border-red-600 bg-red-50 text-red-600',
        className,
      )}
    >
      {children}
    </span>
  );
}
