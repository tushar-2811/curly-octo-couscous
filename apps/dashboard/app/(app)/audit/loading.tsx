import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-busy>
      <span className="sr-only">Loading the audit log</span>
      <Skeleton className="h-8 w-40" />
      <Skeleton className="mt-2 h-4 w-96" />
      <Skeleton className="mt-8 h-20 w-full" />
      <div className="mt-6 space-y-px">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-none" />
        ))}
      </div>
    </div>
  );
}
