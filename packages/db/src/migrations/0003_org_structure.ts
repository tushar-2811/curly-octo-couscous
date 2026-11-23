import { sql, type Kysely } from 'kysely';

/**
 * Phase 1, slice 2: org structure.
 * - org_units: one tree for departments and teams, any depth (Technical architecture §9)
 * - members.org_unit_id: where a person or AI employee sits
 * - reporting_lines: line manager (one per member) and dotted-line managers
 * - app.claim_member_for_email: lets a person added by an admin sign in for the first time
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table workforce.org_units (
      id uuid primary key default uuidv7(),
      org_id uuid not null references workforce.organizations (id),
      parent_id uuid,
      kind text not null check (kind in ('department', 'team', 'other')),
      name text not null check (length(name) between 1 and 120),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (org_id, id),
      foreign key (org_id, parent_id) references workforce.org_units (org_id, id),
      check (parent_id is null or parent_id <> id)
    )
  `.execute(db);
  // Sibling names are unique (case-insensitive) within a parent.
  await sql`
    create unique index org_units_sibling_name_uq on workforce.org_units
      (org_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  `.execute(db);

  await sql`alter table workforce.members add column org_unit_id uuid`.execute(db);
  await sql`
    alter table workforce.members add constraint members_org_unit_fk
      foreign key (org_id, org_unit_id) references workforce.org_units (org_id, id)
  `.execute(db);
  await sql`create index members_org_unit_idx on workforce.members (org_id, org_unit_id)`.execute(
    db,
  );

  await sql`
    create table workforce.reporting_lines (
      org_id uuid not null,
      member_id uuid not null,
      manager_member_id uuid not null,
      kind text not null check (kind in ('line', 'dotted')),
      created_at timestamptz not null default now(),
      primary key (org_id, member_id, manager_member_id, kind),
      foreign key (org_id, member_id) references workforce.members (org_id, id),
      foreign key (org_id, manager_member_id) references workforce.members (org_id, id),
      check (member_id <> manager_member_id)
    )
  `.execute(db);
  // At most one line manager per member.
  await sql`
    create unique index reporting_lines_one_line_manager on workforce.reporting_lines (org_id, member_id)
      where kind = 'line'
  `.execute(db);
  await sql`create index reporting_lines_manager_idx on workforce.reporting_lines (org_id, manager_member_id)`.execute(
    db,
  );

  for (const table of ['workforce.org_units', 'workforce.reporting_lines']) {
    await sql.raw(`alter table ${table} enable row level security`).execute(db);
    await sql.raw(`alter table ${table} force row level security`).execute(db);
    await sql
      .raw(
        `create policy tenant_isolation on ${table} using (org_id = app.current_org_id()) with check (org_id = app.current_org_id())`,
      )
      .execute(db);
  }
  await sql`grant select, insert, update, delete on workforce.org_units, workforce.reporting_lines to aiw_app`.execute(
    db,
  );

  // First sign-in of a person an admin added: attach the identity-provider subject to the
  // single active, unclaimed human member with that email. Returns ids only.
  await sql`
    create function app.claim_member_for_email(p_subject text, p_email text)
    returns table (member_id uuid, org_id uuid)
    language plpgsql volatile security definer set search_path = pg_catalog, workforce
    as $$
    declare
      v_count int;
    begin
      select count(*) into v_count from workforce.members
        where email = lower(p_email) and auth_subject is null and status = 'active' and type = 'human';
      if v_count <> 1 then
        return;
      end if;
      return query
        update workforce.members set auth_subject = p_subject, updated_at = now()
        where email = lower(p_email) and auth_subject is null and status = 'active' and type = 'human'
        returning id, members.org_id;
    end $$
  `.execute(db);
  await sql`revoke all on function app.claim_member_for_email(text, text) from public`.execute(db);
  await sql`grant execute on function app.claim_member_for_email(text, text) to aiw_app`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop function if exists app.claim_member_for_email(text, text)`.execute(db);
  await sql`drop table if exists workforce.reporting_lines`.execute(db);
  await sql`alter table workforce.members drop constraint if exists members_org_unit_fk`.execute(
    db,
  );
  await sql`alter table workforce.members drop column if exists org_unit_id`.execute(db);
  await sql`drop table if exists workforce.org_units`.execute(db);
}
