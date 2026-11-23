import { Badge } from '@/components/ui/badge';
import { AI_STATE_LABELS, type AiState } from '@/lib/types';

/** Lifecycle state badge: red for a failed onboarding, solid for suspended. */
export function EmployeeState({ state }: { state: AiState }) {
  const variant =
    state === 'onboarding_failed'
      ? 'danger'
      : state === 'suspended'
        ? 'solid'
        : state === 'active'
          ? 'outline'
          : 'muted';
  return <Badge variant={variant}>{AI_STATE_LABELS[state] ?? state}</Badge>;
}
