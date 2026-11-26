import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-busy>
      <span className="sr-only">Loading memory</span>
      <Skeleton className="h-4 w-32" />
      <Skeleton className="mt-4 h-8 w-56" />
      <Skeleton className="mt-8 h-10 w-full" />
      <div className="mt-6 space-y-px">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-none" />
        ))}
      </div>
    </div>
  );
}
