import { Skeleton } from '@/components/ui/skeleton';

/** Route-level loading state: mirrors the page layout so content does not jump in. */
export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-busy>
      <span className="sr-only">Loading page</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="mt-2 h-4 w-72" />
      <div className="mt-8 grid gap-6">
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    </div>
  );
}
