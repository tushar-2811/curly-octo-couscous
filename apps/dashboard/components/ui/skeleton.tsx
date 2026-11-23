import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Placeholder block shown while content loads; hidden from screen readers. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn('animate-shimmer rounded-md bg-gray-100', className)}
      {...props}
    />
  );
}
