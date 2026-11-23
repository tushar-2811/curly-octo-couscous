import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Small outlined label. `solid` for the one state that needs emphasis in a list. */
export function Badge({
  children,
  variant = 'outline',
  className,
}: {
  children: ReactNode;
  variant?: 'outline' | 'solid' | 'muted';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium leading-none',
        variant === 'outline' && 'border-black',
        variant === 'solid' && 'border-black bg-black text-white',
        variant === 'muted' && 'border-gray-300 text-gray-600',
        className,
      )}
    >
      {children}
    </span>
  );
}
