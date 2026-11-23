import { Badge } from '@/components/ui/badge';
import type { Member } from '@/lib/types';

/** Deactivated → solid; invited but never signed in → muted; otherwise outlined "Active". */
export function MemberStatus({ member }: { member: Member }) {
  if (member.status !== 'active') return <Badge variant="solid">Deactivated</Badge>;
  if (member.type === 'human' && !member.signed_in)
    return <Badge variant="muted">Not signed in yet</Badge>;
  return <Badge>Active</Badge>;
}
