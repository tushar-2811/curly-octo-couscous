'use client';

import { RotateCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';

/** Re-run the server components on this page, showing a busy state while it reloads. */
export function RetryButton({ label = 'Try again' }: { label?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="secondary"
      size="sm"
      loading={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      {!pending && <RotateCw className="size-4" aria-hidden />}
      {pending ? 'Retrying' : label}
    </Button>
  );
}
