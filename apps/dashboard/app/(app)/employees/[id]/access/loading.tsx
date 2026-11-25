import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-busy>
      <span className="sr-only">Loading access</span>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-8 w-64" />
      <div className="mt-8 grid gap-6">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  );
}
