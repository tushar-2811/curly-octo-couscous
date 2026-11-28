import { Writable } from 'node:stream';
import { createDb, createMigrator, withTenant, type Member, type OrgUnit } from '@aiw/db';
import { createLogger } from '@aiw/logger';
import type { ActorContext } from '@aiw/platform';
import { addPerson, createOrgUnit, hireEmployee, registerOrganization } from '@aiw/workforce';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orgChartEvidence } from './org-chart';

const url = process.env.TEST_DATABASE_URL;
const silent = createLogger({
  service: 'test',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

describe.skipIf(!url)('org chart evidence', () => {
  const db = createDb({ connectionString: url ?? 'postgres://unused', logger: silent });
  const run = Date.now().toString(36);
  const domain = `org-${run}.test`;
  let admin: Member;
  let grace: Member;
  let mia: Member;
  let nova: Member;
  let engineering: OrgUnit;
  let payments: OrgUnit;
  let ctx: ActorContext;
  const inOrg = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, ctx.orgId, fn);

  beforeAll(async () => {
    const up = await createMigrator(db as never).migrateToLatest();
    if (up.error) throw up.error;
    const reg = await registerOrganization(db, {
      subject: `test:org-${run}`,
      email: `owner@${domain}`,
      displayName: 'Owner',
      orgName: 'Org Co',
      domain,
      requestId: 'req-setup',
    });
    admin = reg.member;
    ctx = { orgId: reg.organization.id, actorMemberId: admin.id, requestId: 'req-test' };
    engineering = await inOrg((trx) =>
      createOrgUnit(trx, ctx, admin, { name: 'Engineering', kind: 'department', parentId: null }),
    );
    payments = await inOrg((trx) =>
      createOrgUnit(trx, ctx, admin, { name: 'Payments', kind: 'team', parentId: engineering.id }),
    );
    const person = (name: string, title: string, unit: string | null, manager: string | null) =>
      inOrg((trx) =>
        addPerson(trx, ctx, admin, {
          displayName: name,
          email: `${name.split(' ')[0]!.toLowerCase()}@${domain}`,
          title,
          role: 'member',
          orgUnitId: unit,
          managerId: manager,
        }),
      );
    grace = await person('Grace Hopper', 'Engineering Manager', engineering.id, null);
    mia = await person('Mia Wong', 'Backend Engineer', payments.id, grace.id);
    nova = await inOrg((trx) =>
      hireEmployee(trx, ctx, admin, {
        displayName: 'Nova',
        roleKey: 'frontend_engineer',
        title: 'Frontend Engineer',
        orgUnitId: payments.id,
        managerId: grace.id,
        instructions: '',
        email: `nova@${domain}`,
      }),
    );
  });
  afterAll(() => db.destroy());

  it('describes the employee itself and the sender', async () => {
    const { items, notes } = await inOrg((trx) =>
      orgChartEvidence(trx, {
        employeeId: nova.id,
        senderMemberId: mia.id,
        people: [],
        text: 'who is your manager and what team are you on?',
      }),
    );
    expect(notes).toEqual([]);
    expect(items.map((i) => i.label)).toEqual(['Nova', 'Mia Wong']);
    expect(items[0]!.content).toContain('You: Nova (Frontend Engineer) [AI employee]');
    expect(items[0]!.content).toContain('Team: Payments team, in Engineering department.');
    expect(items[0]!.content).toContain('Reports to: Grace Hopper (Engineering Manager).');
    expect(items[1]!.content).toMatch(/^The sender: Mia Wong/);
  });

  it('finds named people by first name, with their reports, and says who is missing', async () => {
    const { items, notes } = await inOrg((trx) =>
      orgChartEvidence(trx, {
        employeeId: nova.id,
        senderMemberId: null,
        people: ['grace', 'Zed'],
        text: 'who reports to Grace?',
      }),
    );
    const g = items.find((i) => i.label === 'Grace Hopper')!;
    expect(g.content).toContain('Reports to: no manager set in the org chart.');
    expect(g.content).toContain(
      'Direct reports: Mia Wong (Backend Engineer), Nova (Frontend Engineer) [AI employee].',
    );
    expect(notes).toEqual(['No one named "Zed" is in the org chart.']);
  });

  it('lists the members of a team named in the message, including teams inside it', async () => {
    const { items } = await inOrg((trx) =>
      orgChartEvidence(trx, {
        employeeId: nova.id,
        senderMemberId: null,
        people: [],
        text: 'Who is in engineering?',
      }),
    );
    const team = items.find((i) => i.kind === 'team')!;
    expect(team).toMatchObject({ source: 'org_chart', label: 'Engineering' });
    expect(team.content).toContain('Contains: Payments.');
    expect(team.content).toContain('Members (3)');
    expect(team.content).toContain('Mia Wong (Backend Engineer)');
  });
});
