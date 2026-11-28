import type { Tx } from '@aiw/db';
import type { Evidence } from './answer';

/**
 * The organization's own structure as evidence for an answer: who someone is, their title,
 * team and department, who they report to and who reports to them, and who is on a team.
 * Everyone in the organization can see the org chart, so this is not filtered by readers.
 * Read only, from what the company set up in the app.
 */

const MAX_PEOPLE_PER_NAME = 3;
const MAX_TEAMS = 3;
const MAX_TEAM_MEMBERS = 25;
const MAX_REPORTS = 15;
const GONE = ['terminated', 'removed'];

export interface OrgChartRequest {
  employeeId: string;
  /** The sender, when they are a member. */
  senderMemberId: string | null;
  /** People named in the message (from the classifier). */
  people: string[];
  /** The message text, to find team names in. */
  text: string;
}

interface Person {
  id: string;
  display_name: string;
  type: 'human' | 'ai';
  title: string | null;
  email: string | null;
  org_unit_id: string | null;
}

interface Unit {
  id: string;
  name: string;
  kind: string;
  parent_id: string | null;
}

const lower = (s: string) => s.toLowerCase();

/** "Payments team, in Engineering department" — the unit and the units above it. */
function unitPath(unitId: string | null, units: Map<string, Unit>): string | null {
  const parts: string[] = [];
  const seen = new Set<string>();
  let id = unitId;
  while (id && !seen.has(id) && parts.length < 6) {
    seen.add(id);
    const u = units.get(id);
    if (!u) break;
    parts.push(`${u.name} ${u.kind === 'other' ? 'group' : u.kind}`);
    id = u.parent_id;
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : `${parts[0]}, in ${parts.slice(1).join(', in ')}`;
}

const describe = (p: Person) =>
  `${p.display_name}${p.title ? ` (${p.title})` : ''}${p.type === 'ai' ? ' [AI employee]' : ''}`;

/** Org chart evidence for the people and teams a message is about. */
export async function orgChartEvidence(
  trx: Tx,
  request: OrgChartRequest,
): Promise<{ items: Evidence[]; notes: string[] }> {
  const [peopleRows, unitRows, lineRows] = await Promise.all([
    trx
      .selectFrom('workforce.members')
      .select(['id', 'display_name', 'type', 'title', 'email', 'org_unit_id'])
      .where('status', 'not in', GONE)
      .limit(5000)
      .execute(),
    trx.selectFrom('workforce.org_units').select(['id', 'name', 'kind', 'parent_id']).execute(),
    trx
      .selectFrom('workforce.reporting_lines')
      .select(['member_id', 'manager_member_id', 'kind'])
      .execute(),
  ]);
  const people = new Map(peopleRows.map((p) => [p.id, p as Person]));
  const units = new Map(unitRows.map((u) => [u.id, u as Unit]));
  const managersOf = (id: string) =>
    lineRows.filter((l) => l.member_id === id && people.has(l.manager_member_id));
  const reportsOf = (id: string) =>
    lineRows.filter((l) => l.manager_member_id === id && people.has(l.member_id));

  const personCard = (p: Person, who: string): Evidence => {
    const lines = [`${who}: ${describe(p)}${p.email ? `, ${p.email}` : ''}.`];
    const unit = unitPath(p.org_unit_id, units);
    lines.push(unit ? `Team: ${unit}.` : 'Team: not set in the org chart.');
    const managers = managersOf(p.id);
    const line = managers.filter((m) => m.kind === 'line');
    const dotted = managers.filter((m) => m.kind !== 'line');
    lines.push(
      line.length > 0
        ? `Reports to: ${line.map((m) => describe(people.get(m.manager_member_id)!)).join(', ')}.`
        : 'Reports to: no manager set in the org chart.',
    );
    if (dotted.length > 0) {
      lines.push(
        `Dotted-line manager: ${dotted.map((m) => describe(people.get(m.manager_member_id)!)).join(', ')}.`,
      );
    }
    const reports = reportsOf(p.id);
    if (reports.length > 0) {
      const shown = reports.slice(0, MAX_REPORTS).map((r) => describe(people.get(r.member_id)!));
      const more = reports.length > MAX_REPORTS ? ` and ${reports.length - MAX_REPORTS} more` : '';
      lines.push(`Direct reports: ${shown.join(', ')}${more}.`);
    }
    return {
      id: p.id,
      source: 'org_chart',
      kind: 'person',
      content: lines.join(' '),
      occurred_at: null,
      label: p.display_name,
    };
  };

  const items: Evidence[] = [];
  const notes: string[] = [];
  const added = new Set<string>();
  const addPerson = (p: Person, who: string) => {
    if (added.has(p.id)) return;
    added.add(p.id);
    items.push(personCard(p, who));
  };

  const self = people.get(request.employeeId);
  if (self) addPerson(self, 'You');
  const sender = request.senderMemberId ? people.get(request.senderMemberId) : undefined;
  if (sender) addPerson(sender, 'The sender');

  for (const raw of request.people) {
    const name = raw.trim();
    if (name.length < 2) continue;
    const q = lower(name);
    // Whole name first, then any person whose name contains every word ("Chirag" → "Chirag Dubey").
    const words = q.split(/\s+/);
    const matches = peopleRows.filter((p) => {
      const n = lower(p.display_name);
      return n === q || words.every((w) => n.split(/\s+/).some((part) => part.startsWith(w)));
    });
    if (matches.length === 0) {
      notes.push(`No one named "${name}" is in the org chart.`);
      continue;
    }
    if (matches.length > MAX_PEOPLE_PER_NAME) {
      notes.push(
        `${matches.length} people match "${name}"; the first ${MAX_PEOPLE_PER_NAME} are shown.`,
      );
    }
    for (const p of matches.slice(0, MAX_PEOPLE_PER_NAME)) addPerson(p as Person, 'Person');
  }

  // Teams and departments named in the message ("who is on Payments?").
  const text = ` ${lower(request.text).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const named = unitRows
    .filter((u) => u.name.trim().length >= 3)
    .filter((u) =>
      text.includes(
        ` ${lower(u.name)
          .replace(/[^\p{L}\p{N}]+/gu, ' ')
          .trim()} `,
      ),
    )
    .slice(0, MAX_TEAMS);
  for (const u of named) {
    // Members of the unit and of the units inside it.
    const inside = new Set([u.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const x of unitRows) {
        if (x.parent_id && inside.has(x.parent_id) && !inside.has(x.id)) {
          inside.add(x.id);
          grew = true;
        }
      }
    }
    const members = peopleRows.filter((p) => p.org_unit_id && inside.has(p.org_unit_id));
    const shown = members.slice(0, MAX_TEAM_MEMBERS).map((p) => describe(p as Person));
    const more =
      members.length > MAX_TEAM_MEMBERS ? ` and ${members.length - MAX_TEAM_MEMBERS} more` : '';
    const children = unitRows.filter((x) => x.parent_id === u.id).map((x) => x.name);
    items.push({
      id: u.id,
      source: 'org_chart',
      kind: 'team',
      content: [
        `Team: ${unitPath(u.id, units)}.`,
        children.length > 0 ? `Contains: ${children.join(', ')}.` : '',
        members.length > 0
          ? `Members (${members.length}): ${shown.join(', ')}${more}.`
          : 'No members are assigned to it in the org chart.',
      ]
        .filter(Boolean)
        .join(' '),
      occurred_at: null,
      label: u.name,
    });
  }
  return { items, notes };
}
