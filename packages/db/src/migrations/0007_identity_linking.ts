import { sql, type Kysely } from 'kysely';

/**
 * Phase 1, slice 5: linking an AI employee's company Google account (Identity linking §3–§5).
 * - workforce.external_identities: accounts an employee uses. Only a verified Google ID
 *   token creates one. One Google account can be connected to one employee at a time,
 *   across all organizations.
 * - workforce.oauth_link_requests: single-use, 10-minute OAuth requests. Only hashes of
 *   the state and nonce are stored; the PKCE verifier is encrypted.
 * - platform.secrets: encrypted secret values (refresh tokens) for local and single-host
 *   deployments. A cloud secret manager can replace it behind the same reference.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table platform.secrets (
      id uuid primary key default uuidv7(),
      org_id uuid not null references workforce.organizations (id),
      purpose text not null check (length(purpose) between 1 and 64),
      ciphertext text not null,
      created_at timestamptz not null default now()
    )
  `.execute(db);

  await sql`
    create table workforce.external_identities (
      id uuid primary key default uuidv7(),
      org_id uuid not null,
      member_id uuid not null,
      provider text not null check (provider in ('google_workspace')),
      provider_user_id text not null check (length(provider_user_id) between 1 and 255),
      email_address text not null check (length(email_address) between 3 and 254),
      hosted_domain text,
      authentication_status text not null default 'verified'
        check (authentication_status in ('unverified', 'verified', 'failed')),
      granted_scopes text[] not null default '{}',
      connection_status text not null default 'connected'
        check (connection_status in ('pending', 'connected', 'reauth_required', 'revoked', 'disconnected')),
      is_primary boolean not null default true,
      credential_ref uuid references platform.secrets (id) on delete set null,
      last_verified_at timestamptz,
      last_error text check (last_error is null or length(last_error) <= 2000),
      connected_at timestamptz not null default now(),
      disconnected_at timestamptz,
      created_by uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      foreign key (org_id, member_id) references workforce.members (org_id, id)
    )
  `.execute(db);
  // One Google account, one employee, while it is in use.
  await sql`
    create unique index external_identities_subject_uq
      on workforce.external_identities (provider, provider_user_id)
      where connection_status in ('connected', 'reauth_required')
  `.execute(db);
  await sql`
    create unique index external_identities_primary_uq
      on workforce.external_identities (member_id, provider)
      where is_primary and connection_status in ('connected', 'reauth_required')
  `.execute(db);
  await sql`create index external_identities_member_idx on workforce.external_identities (org_id, member_id)`.execute(
    db,
  );

  await sql`
    create table workforce.oauth_link_requests (
      state_hash text primary key,
      org_id uuid not null,
      member_id uuid not null,
      provider text not null check (provider in ('google_workspace')),
      expected_email text not null,
      nonce_hash text not null,
      pkce_verifier text not null,
      requested_scopes text[] not null,
      created_by uuid not null,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      consumed_at timestamptz,
      foreign key (org_id, member_id) references workforce.members (org_id, id)
    )
  `.execute(db);
  await sql`create index oauth_link_requests_member_idx on workforce.oauth_link_requests (org_id, member_id)`.execute(
    db,
  );

  for (const table of [
    'platform.secrets',
    'workforce.external_identities',
    'workforce.oauth_link_requests',
  ]) {
    await sql`alter table ${sql.raw(table)} enable row level security`.execute(db);
    await sql`alter table ${sql.raw(table)} force row level security`.execute(db);
    await sql`
      create policy tenant_isolation on ${sql.raw(table)}
        using (org_id = app.current_org_id()) with check (org_id = app.current_org_id())
    `.execute(db);
  }
  // Identities are never deleted (history); secrets are deleted when revoked.
  await sql`grant select, insert, update on workforce.external_identities, workforce.oauth_link_requests to aiw_app`.execute(
    db,
  );
  await sql`grant select, insert, delete on platform.secrets to aiw_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists workforce.oauth_link_requests`.execute(db);
  await sql`drop table if exists workforce.external_identities`.execute(db);
  await sql`drop table if exists platform.secrets`.execute(db);
}
