import type { MemberRow, OrgUnit } from './types';
import { UNIT_KIND_LABELS } from './types';
import type { SelectOption } from '@/components/ui/select-field';

export interface UnitNode extends OrgUnit {
  children: UnitNode[];
  members: MemberRow[];
  depth: number;
}

/** Build the unit tree, attaching each active member to their unit. */
export function buildUnitTree(
  units: OrgUnit[],
  members: MemberRow[],
): { roots: UnitNode[]; unassigned: MemberRow[] } {
  const nodes = new Map<string, UnitNode>(
    units.map((u) => [u.id, { ...u, children: [], members: [], depth: 0 }]),
  );
  const roots: UnitNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id ? nodes.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const unassigned: MemberRow[] = [];
  for (const m of members) {
    const node = m.org_unit ? nodes.get(m.org_unit.id) : undefined;
    if (node) node.members.push(m);
    else unassigned.push(m);
  }
  const sortAndDepth = (list: UnitNode[], depth: number) => {
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of list) {
      n.depth = depth;
      sortAndDepth(n.children, depth + 1);
    }
  };
  sortAndDepth(roots, 0);
  return { roots, unassigned };
}

/** Units as indented select options, e.g. "Engineering" then "— Frontend". */
export function unitOptions(units: OrgUnit[], emptyLabel: string): SelectOption[] {
  const { roots } = buildUnitTree(units, []);
  const out: SelectOption[] = [{ value: '', label: emptyLabel }];
  const walk = (list: UnitNode[]) => {
    for (const n of list) {
      out.push({
        value: n.id,
        label: `${'— '.repeat(n.depth)}${n.name} (${UNIT_KIND_LABELS[n.kind]})`,
      });
      walk(n.children);
    }
  };
  walk(roots);
  return out;
}

export function managerOptions(members: MemberRow[], excludeId?: string): SelectOption[] {
  return [
    { value: '', label: 'No manager' },
    ...members
      .filter((m) => m.status === 'active' && m.id !== excludeId)
      .map((m) => ({
        value: m.id,
        label: m.title ? `${m.display_name} · ${m.title}` : m.display_name,
      })),
  ];
}
