-- HFSAA Developer API accountless portals and Google Forms ingestion
-- Apply after database/developer_api_mvp.sql.

begin;

alter table public.developer_api_applications
  add column submission_source text not null default 'direct'
    check (submission_source in ('direct', 'google_forms')),
  add column source_reference text
    check (source_reference is null or char_length(source_reference) between 1 and 200);

create unique index developer_api_applications_source_reference_idx
  on public.developer_api_applications (submission_source, source_reference)
  where source_reference is not null;

create table public.developer_api_management_tokens (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(email) and char_length(email) between 3 and 320),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz not null default now()
);

create index developer_api_management_tokens_email_idx
  on public.developer_api_management_tokens (email, created_at desc);

create table public.developer_api_management_sessions (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(email) and char_length(email) between 3 and 320),
  session_hash text not null unique check (session_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index developer_api_management_sessions_email_idx
  on public.developer_api_management_sessions (email, expires_at desc);

alter table public.developer_api_management_tokens enable row level security;
alter table public.developer_api_management_sessions enable row level security;

revoke all on table public.developer_api_management_tokens from anon, authenticated;
revoke all on table public.developer_api_management_sessions from anon, authenticated;

grant select, insert, update, delete on table public.developer_api_management_tokens to service_role;
grant select, insert, update, delete on table public.developer_api_management_sessions to service_role;

create function public.developer_api_submit_external_application(
  p_applicant_name text,
  p_email text,
  p_organization text,
  p_website text,
  p_use_case text,
  p_requested_tier text,
  p_expected_monthly_requests integer,
  p_verification_token_hash text,
  p_verification_expires_at timestamptz,
  p_submission_source text,
  p_source_reference text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_application_id uuid;
begin
  if p_submission_source <> 'google_forms'
    or nullif(trim(p_source_reference), '') is null
    or char_length(trim(p_source_reference)) > 200 then
    raise exception 'invalid_submission_source';
  end if;

  v_result := public.developer_api_submit_application(
    p_applicant_name,
    p_email,
    p_organization,
    p_website,
    p_use_case,
    p_requested_tier,
    p_expected_monthly_requests,
    p_verification_token_hash,
    p_verification_expires_at
  );
  v_application_id := (v_result ->> 'application_id')::uuid;

  update public.developer_api_applications
  set submission_source = p_submission_source,
      source_reference = trim(p_source_reference),
      updated_at = now()
  where id = v_application_id
    and (source_reference is null
      or (submission_source = p_submission_source and source_reference = trim(p_source_reference)));

  if not found then
    raise exception 'source_reference_conflict';
  end if;

  return v_result || jsonb_build_object(
    'submission_source', p_submission_source,
    'source_reference', trim(p_source_reference)
  );
end;
$$;

create function public.developer_api_create_management_token(
  p_email text,
  p_token_hash text,
  p_expires_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(trim(p_email));
  v_name text;
begin
  delete from public.developer_api_management_tokens
  where expires_at < now() - interval '1 day';
  delete from public.developer_api_management_sessions
  where expires_at < now() - interval '1 day';

  select application.applicant_name into v_name
  from public.developer_api_applications application
  where application.email = v_email
    and (application.status = 'approved'
      or exists (
        select 1 from public.developer_api_keys key
        where key.application_id = application.id
      ))
  order by application.created_at desc
  limit 1;

  if not found then
    return jsonb_build_object('should_send', false);
  end if;

  update public.developer_api_management_tokens
  set invalidated_at = now()
  where email = v_email
    and consumed_at is null
    and invalidated_at is null;

  insert into public.developer_api_management_tokens (email, token_hash, expires_at)
  values (v_email, p_token_hash, p_expires_at);

  return jsonb_build_object(
    'should_send', true,
    'email', v_email,
    'applicant_name', v_name
  );
end;
$$;

create function public.developer_api_exchange_management_token(
  p_token_hash text,
  p_session_hash text,
  p_session_expires_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token public.developer_api_management_tokens%rowtype;
begin
  update public.developer_api_management_tokens
  set consumed_at = now()
  where token_hash = p_token_hash
    and consumed_at is null
    and invalidated_at is null
    and expires_at > now()
  returning * into v_token;

  if not found then
    return jsonb_build_object('authenticated', false);
  end if;

  insert into public.developer_api_management_sessions (email, session_hash, expires_at)
  values (v_token.email, p_session_hash, p_session_expires_at);

  return jsonb_build_object('authenticated', true, 'email', v_token.email);
end;
$$;

create function public.developer_api_management_overview(p_session_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.developer_api_management_sessions%rowtype;
  v_period date := date_trunc('month', timezone('utc', now()))::date;
  v_reset_at timestamptz := (date_trunc('month', timezone('utc', now())) + interval '1 month') at time zone 'UTC';
  v_name text;
begin
  update public.developer_api_management_sessions
  set last_seen_at = now()
  where session_hash = p_session_hash
    and revoked_at is null
    and expires_at > now()
  returning * into v_session;

  if not found then
    return jsonb_build_object('authenticated', false);
  end if;

  select application.applicant_name into v_name
  from public.developer_api_applications application
  where application.email = v_session.email
  order by application.created_at desc
  limit 1;

  return jsonb_build_object(
    'authenticated', true,
    'email', v_session.email,
    'applicant_name', v_name,
    'reset_at', v_reset_at,
    'applications', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', application.id,
        'requested_tier', application.requested_tier,
        'status', application.status,
        'created_at', application.created_at,
        'decision_reason', application.decision_reason
      ) order by application.created_at desc)
      from public.developer_api_applications application
      where application.email = v_session.email
    ), '[]'::jsonb),
    'keys', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', key.id,
        'key_prefix', key.key_prefix,
        'environment', key.environment,
        'status', key.status,
        'monthly_limit', key.monthly_limit,
        'current_month_requests', coalesce(usage.request_count, 0),
        'current_month_remaining', greatest(key.monthly_limit - coalesce(usage.request_count, 0), 0),
        'rate_limit_per_minute', key.rate_limit_per_minute,
        'last_used_at', key.last_used_at,
        'activated_at', key.activated_at,
        'revoked_at', key.revoked_at,
        'revocation_reason', key.revocation_reason
      ) order by key.created_at desc)
      from public.developer_api_keys key
      join public.developer_api_applications application on application.id = key.application_id
      left join public.developer_api_usage_monthly usage
        on usage.key_id = key.id and usage.period_start = v_period
      where application.email = v_session.email
    ), '[]'::jsonb)
  );
end;
$$;

create function public.developer_api_revoke_own_key(
  p_session_hash text,
  p_key_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.developer_api_management_sessions%rowtype;
  v_key public.developer_api_keys%rowtype;
  v_application public.developer_api_applications%rowtype;
begin
  select * into v_session
  from public.developer_api_management_sessions
  where session_hash = p_session_hash and revoked_at is null and expires_at > now();
  if not found then
    return jsonb_build_object('authenticated', false, 'revoked', false);
  end if;

  update public.developer_api_keys key
  set status = 'revoked',
      revoked_at = now(),
      revocation_reason = left(trim(p_reason), 1000),
      updated_at = now()
  from public.developer_api_applications application
  where key.id = p_key_id
    and key.application_id = application.id
    and application.email = v_session.email
    and key.status = 'active'
  returning key.* into v_key;

  if not found then
    return jsonb_build_object('authenticated', true, 'revoked', false);
  end if;
  select * into v_application from public.developer_api_applications where id = v_key.application_id;
  return jsonb_build_object(
    'authenticated', true,
    'revoked', true,
    'key_id', v_key.id,
    'key_prefix', v_key.key_prefix,
    'email', v_application.email,
    'applicant_name', v_application.applicant_name
  );
end;
$$;

create function public.developer_api_rotate_own_key(
  p_session_hash text,
  p_key_id uuid,
  p_claim_token_hash text,
  p_claim_expires_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.developer_api_management_sessions%rowtype;
  v_key public.developer_api_keys%rowtype;
  v_application public.developer_api_applications%rowtype;
begin
  select * into v_session
  from public.developer_api_management_sessions
  where session_hash = p_session_hash and revoked_at is null and expires_at > now();
  if not found then
    return jsonb_build_object('authenticated', false, 'rotated', false);
  end if;

  select key.* into v_key
  from public.developer_api_keys key
  join public.developer_api_applications application on application.id = key.application_id
  where key.id = p_key_id
    and application.email = v_session.email
    and key.status = 'active'
  for update of key;
  if not found then
    return jsonb_build_object('authenticated', true, 'rotated', false);
  end if;

  select * into v_application
  from public.developer_api_applications
  where id = v_key.application_id;

  update public.developer_api_keys
  set status = 'revoked',
      revoked_at = now(),
      revocation_reason = 'Rotated by developer',
      updated_at = now()
  where id = v_key.id;

  update public.developer_api_key_claims
  set invalidated_at = now()
  where application_id = v_key.application_id
    and consumed_at is null
    and invalidated_at is null;

  insert into public.developer_api_key_claims (
    application_id, claim_token_hash, monthly_limit, rate_limit_per_minute, expires_at
  ) values (
    v_key.application_id, p_claim_token_hash, v_key.monthly_limit,
    v_key.rate_limit_per_minute, p_claim_expires_at
  );

  return jsonb_build_object(
    'authenticated', true,
    'rotated', true,
    'key_id', v_key.id,
    'key_prefix', v_key.key_prefix,
    'email', v_application.email,
    'applicant_name', v_application.applicant_name
  );
end;
$$;

create function public.developer_api_end_management_session(p_session_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.developer_api_management_sessions
  set revoked_at = now()
  where session_hash = p_session_hash and revoked_at is null;
  return jsonb_build_object('signed_out', true);
end;
$$;

revoke all on function public.developer_api_submit_external_application(text, text, text, text, text, text, integer, text, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.developer_api_create_management_token(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.developer_api_exchange_management_token(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.developer_api_management_overview(text) from public, anon, authenticated;
revoke all on function public.developer_api_revoke_own_key(text, uuid, text) from public, anon, authenticated;
revoke all on function public.developer_api_rotate_own_key(text, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.developer_api_end_management_session(text) from public, anon, authenticated;

grant execute on function public.developer_api_submit_external_application(text, text, text, text, text, text, integer, text, timestamptz, text, text) to service_role;
grant execute on function public.developer_api_create_management_token(text, text, timestamptz) to service_role;
grant execute on function public.developer_api_exchange_management_token(text, text, timestamptz) to service_role;
grant execute on function public.developer_api_management_overview(text) to service_role;
grant execute on function public.developer_api_revoke_own_key(text, uuid, text) to service_role;
grant execute on function public.developer_api_rotate_own_key(text, uuid, text, timestamptz) to service_role;
grant execute on function public.developer_api_end_management_session(text) to service_role;

comment on table public.developer_api_management_tokens is 'Hashed, one-time accountless developer portal sign-in links.';
comment on table public.developer_api_management_sessions is 'Hashed, short-lived developer portal sessions.';

commit;

