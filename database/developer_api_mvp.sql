-- HFSAA Developer API MVP
-- Raw verification tokens, claim tokens, and API keys are never stored.

create table public.developer_api_applications (
  id uuid primary key default gen_random_uuid(),
  applicant_name text not null check (char_length(applicant_name) between 1 and 120),
  email text not null check (email = lower(email) and char_length(email) between 3 and 320),
  organization text check (organization is null or char_length(organization) <= 160),
  website text check (website is null or char_length(website) <= 500),
  use_case text not null check (char_length(use_case) between 1 and 2000),
  requested_tier text not null check (requested_tier in ('test', 'production')),
  expected_monthly_requests integer check (expected_monthly_requests is null or expected_monthly_requests between 1 and 100000000),
  status text not null default 'email_verification_required'
    check (status in ('email_verification_required', 'pending_review', 'approved', 'denied')),
  verification_token_hash text check (verification_token_hash is null or verification_token_hash ~ '^[0-9a-f]{64}$'),
  verification_expires_at timestamptz,
  email_verified_at timestamptz,
  decided_at timestamptz,
  decision_reason text check (decision_reason is null or char_length(decision_reason) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (email, requested_tier)
);

create unique index developer_api_applications_verification_hash_idx
  on public.developer_api_applications (verification_token_hash)
  where verification_token_hash is not null;
create index developer_api_applications_review_queue_idx
  on public.developer_api_applications (status, created_at desc);

create table public.developer_api_key_claims (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.developer_api_applications(id) on delete cascade,
  claim_token_hash text not null unique check (claim_token_hash ~ '^[0-9a-f]{64}$'),
  monthly_limit integer not null check (monthly_limit between 1 and 100000000),
  rate_limit_per_minute integer not null check (rate_limit_per_minute between 1 and 100000),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz not null default now()
);

create index developer_api_key_claims_application_idx
  on public.developer_api_key_claims (application_id, created_at desc);

create table public.developer_api_keys (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.developer_api_applications(id) on delete restrict,
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  key_prefix text not null check (char_length(key_prefix) between 10 and 40),
  environment text not null check (environment in ('test', 'production')),
  status text not null default 'active' check (status in ('active', 'revoked')),
  monthly_limit integer not null check (monthly_limit between 1 and 100000000),
  rate_limit_per_minute integer not null check (rate_limit_per_minute between 1 and 100000),
  usage_alert_threshold smallint not null default 80 check (usage_alert_threshold between 1 and 100),
  last_usage_alert_period date,
  last_used_at timestamptz,
  activated_at timestamptz not null default now(),
  revoked_at timestamptz,
  revocation_reason text check (revocation_reason is null or char_length(revocation_reason) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index developer_api_keys_one_active_per_application_idx
  on public.developer_api_keys (application_id)
  where status = 'active';
create index developer_api_keys_environment_status_idx
  on public.developer_api_keys (environment, status);

create table public.developer_api_usage_monthly (
  key_id uuid not null references public.developer_api_keys(id) on delete cascade,
  period_start date not null,
  request_count bigint not null default 0 check (request_count >= 0),
  last_request_at timestamptz not null default now(),
  primary key (key_id, period_start)
);

create index developer_api_usage_monthly_period_idx
  on public.developer_api_usage_monthly (period_start desc);

create table public.developer_api_usage_daily (
  key_id uuid not null references public.developer_api_keys(id) on delete cascade,
  usage_date date not null,
  endpoint text not null check (char_length(endpoint) between 1 and 160),
  request_count bigint not null default 0 check (request_count >= 0),
  last_request_at timestamptz not null default now(),
  primary key (key_id, usage_date, endpoint)
);

create index developer_api_usage_daily_date_idx
  on public.developer_api_usage_daily (usage_date desc);

alter table public.developer_api_applications enable row level security;
alter table public.developer_api_key_claims enable row level security;
alter table public.developer_api_keys enable row level security;
alter table public.developer_api_usage_monthly enable row level security;
alter table public.developer_api_usage_daily enable row level security;

revoke all on table public.developer_api_applications from anon, authenticated;
revoke all on table public.developer_api_key_claims from anon, authenticated;
revoke all on table public.developer_api_keys from anon, authenticated;
revoke all on table public.developer_api_usage_monthly from anon, authenticated;
revoke all on table public.developer_api_usage_daily from anon, authenticated;

grant select, insert, update, delete on table public.developer_api_applications to service_role;
grant select, insert, update, delete on table public.developer_api_key_claims to service_role;
grant select, insert, update, delete on table public.developer_api_keys to service_role;
grant select, insert, update, delete on table public.developer_api_usage_monthly to service_role;
grant select, insert, update, delete on table public.developer_api_usage_daily to service_role;

create function public.developer_api_submit_application(
  p_applicant_name text,
  p_email text,
  p_organization text,
  p_website text,
  p_use_case text,
  p_requested_tier text,
  p_expected_monthly_requests integer,
  p_verification_token_hash text,
  p_verification_expires_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(trim(p_email));
  v_application public.developer_api_applications%rowtype;
begin
  if p_requested_tier not in ('test', 'production') then
    raise exception 'invalid_requested_tier';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_email || ':' || p_requested_tier, 0));
  select * into v_application
  from public.developer_api_applications
  where email = v_email and requested_tier = p_requested_tier
  for update;

  if found and v_application.status in ('pending_review', 'approved') then
    return jsonb_build_object(
      'application_id', v_application.id,
      'should_send_verification', false
    );
  end if;

  if found then
    update public.developer_api_applications
    set applicant_name = trim(p_applicant_name),
        organization = nullif(trim(p_organization), ''),
        website = nullif(trim(p_website), ''),
        use_case = trim(p_use_case),
        expected_monthly_requests = p_expected_monthly_requests,
        status = 'email_verification_required',
        verification_token_hash = p_verification_token_hash,
        verification_expires_at = p_verification_expires_at,
        email_verified_at = null,
        decided_at = null,
        decision_reason = null,
        updated_at = now()
    where id = v_application.id
    returning * into v_application;
  else
    insert into public.developer_api_applications (
      applicant_name, email, organization, website, use_case, requested_tier,
      expected_monthly_requests, verification_token_hash, verification_expires_at
    ) values (
      trim(p_applicant_name), v_email, nullif(trim(p_organization), ''),
      nullif(trim(p_website), ''), trim(p_use_case), p_requested_tier,
      p_expected_monthly_requests, p_verification_token_hash, p_verification_expires_at
    ) returning * into v_application;
  end if;

  return jsonb_build_object(
    'application_id', v_application.id,
    'should_send_verification', true
  );
end;
$$;

create function public.developer_api_verify_application(p_verification_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_application public.developer_api_applications%rowtype;
begin
  update public.developer_api_applications
  set status = 'pending_review',
      email_verified_at = now(),
      verification_token_hash = null,
      verification_expires_at = null,
      updated_at = now()
  where verification_token_hash = p_verification_token_hash
    and status = 'email_verification_required'
    and verification_expires_at > now()
  returning * into v_application;

  if not found then
    return jsonb_build_object('verified', false);
  end if;
  return jsonb_build_object('verified', true, 'application_id', v_application.id);
end;
$$;

create function public.developer_api_approve_application(
  p_application_id uuid,
  p_claim_token_hash text,
  p_claim_expires_at timestamptz,
  p_monthly_limit integer default null,
  p_rate_limit_per_minute integer default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_application public.developer_api_applications%rowtype;
  v_monthly_limit integer;
  v_rate_limit integer;
begin
  select * into v_application
  from public.developer_api_applications
  where id = p_application_id
  for update;

  if not found or v_application.status not in ('pending_review', 'approved') then
    return jsonb_build_object('approved', false, 'reason', 'invalid_status');
  end if;
  if exists (select 1 from public.developer_api_keys where application_id = p_application_id and status = 'active') then
    return jsonb_build_object('approved', false, 'reason', 'active_key_exists');
  end if;

  v_monthly_limit := coalesce(p_monthly_limit, case when v_application.requested_tier = 'test' then 1000 else 100000 end);
  v_rate_limit := coalesce(p_rate_limit_per_minute, case when v_application.requested_tier = 'test' then 10 else 60 end);
  if v_monthly_limit not between 1 and 100000000 or v_rate_limit not between 1 and 100000 then
    raise exception 'invalid_usage_limits';
  end if;

  update public.developer_api_key_claims
  set invalidated_at = now()
  where application_id = p_application_id and consumed_at is null and invalidated_at is null;

  insert into public.developer_api_key_claims (
    application_id, claim_token_hash, monthly_limit, rate_limit_per_minute, expires_at
  ) values (
    p_application_id, p_claim_token_hash, v_monthly_limit, v_rate_limit, p_claim_expires_at
  );

  update public.developer_api_applications
  set status = 'approved', decided_at = now(), decision_reason = null, updated_at = now()
  where id = p_application_id;

  return jsonb_build_object(
    'approved', true,
    'application_id', v_application.id,
    'applicant_name', v_application.applicant_name,
    'email', v_application.email,
    'requested_tier', v_application.requested_tier,
    'monthly_limit', v_monthly_limit,
    'rate_limit_per_minute', v_rate_limit
  );
end;
$$;

create function public.developer_api_deny_application(p_application_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_application public.developer_api_applications%rowtype;
begin
  update public.developer_api_applications
  set status = 'denied', decided_at = now(), decision_reason = trim(p_reason), updated_at = now(),
      verification_token_hash = null, verification_expires_at = null
  where id = p_application_id and status in ('email_verification_required', 'pending_review')
  returning * into v_application;

  if not found then
    return jsonb_build_object('denied', false);
  end if;
  update public.developer_api_key_claims
  set invalidated_at = now()
  where application_id = p_application_id and consumed_at is null and invalidated_at is null;

  return jsonb_build_object(
    'denied', true,
    'application_id', v_application.id,
    'applicant_name', v_application.applicant_name,
    'email', v_application.email
  );
end;
$$;

create function public.developer_api_claim_key(
  p_claim_token_hash text,
  p_test_key_hash text,
  p_test_key_prefix text,
  p_live_key_hash text,
  p_live_key_prefix text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim public.developer_api_key_claims%rowtype;
  v_application public.developer_api_applications%rowtype;
  v_key_id uuid;
  v_environment text;
begin
  select * into v_claim
  from public.developer_api_key_claims
  where claim_token_hash = p_claim_token_hash
  for update;

  if not found or v_claim.consumed_at is not null or v_claim.invalidated_at is not null or v_claim.expires_at <= now() then
    return jsonb_build_object('claimed', false, 'reason', 'invalid_claim');
  end if;

  select * into v_application
  from public.developer_api_applications
  where id = v_claim.application_id
  for update;
  if not found or v_application.status <> 'approved' then
    return jsonb_build_object('claimed', false, 'reason', 'invalid_application');
  end if;
  if exists (select 1 from public.developer_api_keys where application_id = v_application.id and status = 'active') then
    return jsonb_build_object('claimed', false, 'reason', 'active_key_exists');
  end if;

  v_environment := case when v_application.requested_tier = 'production' then 'production' else 'test' end;
  insert into public.developer_api_keys (
    application_id, key_hash, key_prefix, environment, monthly_limit, rate_limit_per_minute
  ) values (
    v_application.id,
    case when v_environment = 'production' then p_live_key_hash else p_test_key_hash end,
    case when v_environment = 'production' then p_live_key_prefix else p_test_key_prefix end,
    v_environment, v_claim.monthly_limit, v_claim.rate_limit_per_minute
  ) returning id into v_key_id;

  update public.developer_api_key_claims set consumed_at = now() where id = v_claim.id;
  return jsonb_build_object(
    'claimed', true,
    'key_id', v_key_id,
    'environment', v_environment,
    'monthly_limit', v_claim.monthly_limit,
    'rate_limit_per_minute', v_claim.rate_limit_per_minute
  );
end;
$$;

create function public.developer_api_authorize_key(
  p_key_hash text,
  p_environment text,
  p_endpoint text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key public.developer_api_keys%rowtype;
  v_application public.developer_api_applications%rowtype;
  v_period date := date_trunc('month', timezone('utc', now()))::date;
  v_usage_date date := timezone('utc', now())::date;
  v_reset_at timestamptz := (date_trunc('month', timezone('utc', now())) + interval '1 month') at time zone 'UTC';
  v_request_count bigint;
  v_should_alert boolean := false;
begin
  select * into v_key
  from public.developer_api_keys
  where key_hash = p_key_hash and environment = p_environment
  for update;

  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_key');
  end if;
  if v_key.status <> 'active' then
    return jsonb_build_object('allowed', false, 'reason', 'revoked');
  end if;

  select coalesce(request_count, 0) into v_request_count
  from public.developer_api_usage_monthly
  where key_id = v_key.id and period_start = v_period;
  v_request_count := coalesce(v_request_count, 0);
  if v_request_count >= v_key.monthly_limit then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'quota_exceeded',
      'retry_after_seconds', greatest(60, extract(epoch from (v_reset_at - now()))::integer)
    );
  end if;

  insert into public.developer_api_usage_monthly (key_id, period_start, request_count, last_request_at)
  values (v_key.id, v_period, 1, now())
  on conflict (key_id, period_start) do update
  set request_count = public.developer_api_usage_monthly.request_count + 1,
      last_request_at = excluded.last_request_at
  returning request_count into v_request_count;

  insert into public.developer_api_usage_daily (key_id, usage_date, endpoint, request_count, last_request_at)
  values (v_key.id, v_usage_date, p_endpoint, 1, now())
  on conflict (key_id, usage_date, endpoint) do update
  set request_count = public.developer_api_usage_daily.request_count + 1,
      last_request_at = excluded.last_request_at;

  if floor((v_request_count::numeric / v_key.monthly_limit::numeric) * 100) >= v_key.usage_alert_threshold
    and v_key.last_usage_alert_period is distinct from v_period then
    v_should_alert := true;
  end if;

  update public.developer_api_keys
  set last_used_at = now(),
      last_usage_alert_period = case when v_should_alert then v_period else last_usage_alert_period end,
      updated_at = now()
  where id = v_key.id;

  select * into v_application from public.developer_api_applications where id = v_key.application_id;
  return jsonb_build_object(
    'allowed', true,
    'key_id', v_key.id,
    'key_prefix', v_key.key_prefix,
    'applicant_name', v_application.applicant_name,
    'email', v_application.email,
    'period_start', v_period,
    'request_count', v_request_count,
    'monthly_limit', v_key.monthly_limit,
    'rate_limit_per_minute', v_key.rate_limit_per_minute,
    'reset_at', v_reset_at,
    'should_alert', v_should_alert
  );
end;
$$;

create function public.developer_api_list_keys(
  p_status text default null,
  p_environment text default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_period date := date_trunc('month', timezone('utc', now()))::date;
begin
  if p_status is not null and p_status not in ('active', 'revoked') then
    raise exception 'invalid_key_status';
  end if;
  if p_environment is not null and p_environment not in ('test', 'production') then
    raise exception 'invalid_key_environment';
  end if;

  return jsonb_build_object(
    'data', coalesce((
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
        'revocation_reason', key.revocation_reason,
        'application_id', application.id,
        'applicant_name', application.applicant_name,
        'email', application.email,
        'organization', application.organization,
        'requested_tier', application.requested_tier
      ) order by key.created_at desc)
      from public.developer_api_keys key
      join public.developer_api_applications application on application.id = key.application_id
      left join public.developer_api_usage_monthly usage
        on usage.key_id = key.id and usage.period_start = v_period
      where (p_status is null or key.status = p_status)
        and (p_environment is null or key.environment = p_environment)
    ), '[]'::jsonb)
  );
end;
$$;

create function public.developer_api_key_usage(
  p_key_id uuid,
  p_days integer default 30
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_key public.developer_api_keys%rowtype;
  v_application public.developer_api_applications%rowtype;
begin
  if p_days not between 1 and 90 then
    raise exception 'invalid_usage_window';
  end if;

  select * into v_key from public.developer_api_keys where id = p_key_id;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  select * into v_application from public.developer_api_applications where id = v_key.application_id;

  return jsonb_build_object(
    'found', true,
    'key', jsonb_build_object(
      'id', v_key.id,
      'key_prefix', v_key.key_prefix,
      'environment', v_key.environment,
      'status', v_key.status,
      'monthly_limit', v_key.monthly_limit,
      'rate_limit_per_minute', v_key.rate_limit_per_minute,
      'last_used_at', v_key.last_used_at,
      'activated_at', v_key.activated_at,
      'revoked_at', v_key.revoked_at
    ),
    'application', jsonb_build_object(
      'id', v_application.id,
      'applicant_name', v_application.applicant_name,
      'email', v_application.email,
      'organization', v_application.organization,
      'requested_tier', v_application.requested_tier
    ),
    'monthly', coalesce((
      select jsonb_agg(to_jsonb(monthly) order by monthly.period_start desc)
      from (
        select period_start, request_count, last_request_at
        from public.developer_api_usage_monthly
        where key_id = p_key_id
        order by period_start desc
        limit 12
      ) monthly
    ), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(to_jsonb(daily) order by daily.usage_date desc, daily.endpoint)
      from (
        select usage_date, endpoint, request_count, last_request_at
        from public.developer_api_usage_daily
        where key_id = p_key_id
          and usage_date >= timezone('utc', now())::date - (p_days - 1)
        order by usage_date desc, endpoint
      ) daily
    ), '[]'::jsonb)
  );
end;
$$;

create function public.developer_api_revoke_key(p_key_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key public.developer_api_keys%rowtype;
  v_application public.developer_api_applications%rowtype;
begin
  update public.developer_api_keys
  set status = 'revoked', revoked_at = now(), revocation_reason = trim(p_reason), updated_at = now()
  where id = p_key_id and status = 'active'
  returning * into v_key;

  if not found then
    return jsonb_build_object('revoked', false);
  end if;
  select * into v_application from public.developer_api_applications where id = v_key.application_id;
  return jsonb_build_object(
    'revoked', true,
    'key_id', v_key.id,
    'key_prefix', v_key.key_prefix,
    'applicant_name', v_application.applicant_name,
    'email', v_application.email
  );
end;
$$;

revoke all on function public.developer_api_submit_application(text, text, text, text, text, text, integer, text, timestamptz) from public, anon, authenticated;
revoke all on function public.developer_api_verify_application(text) from public, anon, authenticated;
revoke all on function public.developer_api_approve_application(uuid, text, timestamptz, integer, integer) from public, anon, authenticated;
revoke all on function public.developer_api_deny_application(uuid, text) from public, anon, authenticated;
revoke all on function public.developer_api_claim_key(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.developer_api_authorize_key(text, text, text) from public, anon, authenticated;
revoke all on function public.developer_api_list_keys(text, text) from public, anon, authenticated;
revoke all on function public.developer_api_key_usage(uuid, integer) from public, anon, authenticated;
revoke all on function public.developer_api_revoke_key(uuid, text) from public, anon, authenticated;

grant execute on function public.developer_api_submit_application(text, text, text, text, text, text, integer, text, timestamptz) to service_role;
grant execute on function public.developer_api_verify_application(text) to service_role;
grant execute on function public.developer_api_approve_application(uuid, text, timestamptz, integer, integer) to service_role;
grant execute on function public.developer_api_deny_application(uuid, text) to service_role;
grant execute on function public.developer_api_claim_key(text, text, text, text, text) to service_role;
grant execute on function public.developer_api_authorize_key(text, text, text) to service_role;
grant execute on function public.developer_api_list_keys(text, text) to service_role;
grant execute on function public.developer_api_key_usage(uuid, integer) to service_role;
grant execute on function public.developer_api_revoke_key(uuid, text) to service_role;

comment on table public.developer_api_applications is 'Accountless HFSAA Developer API access requests.';
comment on table public.developer_api_keys is 'Hashed HFSAA Developer API credentials. Raw keys are never stored.';
comment on table public.developer_api_usage_monthly is 'Authoritative monthly API-key quota counters.';
comment on table public.developer_api_usage_daily is 'Daily per-endpoint API-key usage aggregates.';

