import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-busy>
      <span className="sr-only">Loading AI employee</span>
      <Skeleton className="h-4 w-16" />
      <Skeleton className="mt-4 h-8 w-56" />
      <div className="mt-8 grid gap-6">
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  );
}
