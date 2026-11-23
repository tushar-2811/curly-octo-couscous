import { sql, type Kysely } from 'kysely';

/**
 * Phase 1, slice 3: hiring AI employees.
 * - members.status is now checked per member type. People are active or deactivated; AI
 *   employees follow the onboarding state machine (Identity linking §2).
 * - members.suspension_reason and members.last_error explain suspended and
 *   onboarding_failed states.
 * - ai_profiles: the 1:1 extension for AI members (Technical architecture §9). Role
 *   templates ship as code and are referenced by role_key.
 */
export const AI_STATES = [
  'draft',
  'external_identity_pending',
  'identity_connected',
  'integrations_pending',
  'permissions_configured',
  'environment_ready',
  'active',
  'onboarding_failed',
  'suspended',
  'terminated',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  const aiStates = sql.join(AI_STATES.map((s) => sql.lit(s)));
  await sql`
    alter table workforce.members
      add column suspension_reason text check (
        suspension_reason is null or suspension_reason in
          ('identity_revoked', 'token_invalid', 'integration_lost', 'budget_exhausted', 'manual', 'security')
      ),
      add column last_error text check (last_error is null or length(last_error) <= 2000),
      add constraint members_status_by_type check (
        (type = 'human' and status in ('active', 'deactivated'))
        or (type = 'ai' and status in (${aiStates}))
      )
  `.execute(db);

  await sql`
    create table workforce.ai_profiles (
      member_id uuid primary key,
      org_id uuid not null,
      role_key text not null check (length(role_key) between 1 and 64),
      instructions text not null default '' check (length(instructions) <= 8000),
      capabilities jsonb not null default '[]'::jsonb check (jsonb_typeof(capabilities) = 'array'),
      max_concurrency int not null default 2 check (max_concurrency between 1 and 10),
      max_open_tasks int not null default 6 check (max_open_tasks between 1 and 50),
      model_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(model_policy) = 'object'),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      foreign key (org_id, member_id) references workforce.members (org_id, id)
    )
  `.execute(db);
  await sql`create index ai_profiles_org_role_idx on workforce.ai_profiles (org_id, role_key)`.execute(
    db,
  );
  await sql`alter table workforce.ai_profiles enable row level security`.execute(db);
  await sql`alter table workforce.ai_profiles force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on workforce.ai_profiles
      using (org_id = app.current_org_id()) with check (org_id = app.current_org_id())
  `.execute(db);
  // No delete: a terminated employee's profile is kept with its history.
  await sql`grant select, insert, update on workforce.ai_profiles to aiw_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists workforce.ai_profiles`.execute(db);
  await sql`
    alter table workforce.members
      drop constraint if exists members_status_by_type,
      drop column if exists last_error,
      drop column if exists suspension_reason
  `.execute(db);
}
