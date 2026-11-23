import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div role="status" aria-live="polite" aria-busy>
      <span className="sr-only">Loading org chart</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="mt-2 h-4 w-80" />
      <div className="mt-8 space-y-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="ml-6 h-12 w-[calc(100%-1.5rem)]" />
        <Skeleton className="ml-6 h-12 w-[calc(100%-1.5rem)]" />
        <Skeleton className="h-12 w-full" />
      </div>
    </div>
  );
}
