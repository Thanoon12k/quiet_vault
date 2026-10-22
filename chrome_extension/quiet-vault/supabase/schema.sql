-- Additive schema for Quiet Vault in clinic_queue. No existing app objects are modified.
create table public.quiet_vaults (
  user_id uuid primary key references auth.users(id) on delete cascade,
  format integer not null default 1 check (format = 1),
  iterations integer not null check (iterations = 600000),
  salt text not null check (length(salt) = 24 and salt ~ '^[A-Za-z0-9+/]+={0,2}$'),
  wrapped_key text not null check (length(wrapped_key) = 64 and wrapped_key ~ '^[A-Za-z0-9+/]+={0,2}$'),
  wrap_nonce text not null check (length(wrap_nonce) = 16 and wrap_nonce ~ '^[A-Za-z0-9+/]+={0,2}$'),
  ciphertext text not null check (length(ciphertext) between 24 and 1250000 and ciphertext ~ '^[A-Za-z0-9+/]+={0,2}$'),
  nonce text not null check (length(nonce) = 16 and nonce ~ '^[A-Za-z0-9+/]+={0,2}$'),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

alter table public.quiet_vaults enable row level security;
revoke all on public.quiet_vaults from anon, authenticated;
grant select, insert on public.quiet_vaults to authenticated;
grant update (ciphertext, nonce, revision, updated_at) on public.quiet_vaults to authenticated;

create policy quiet_vault_owner_select on public.quiet_vaults
for select to authenticated using ((select auth.uid()) = user_id);
create policy quiet_vault_owner_insert on public.quiet_vaults
for insert to authenticated with check ((select auth.uid()) = user_id and revision = 1);
create policy quiet_vault_owner_update on public.quiet_vaults
for update to authenticated using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- Optimistic concurrency: a stale writer receives zero rows and must merge/retry.
create function public.quiet_vault_save(expected_revision bigint, new_ciphertext text, new_nonce text)
returns setof public.quiet_vaults
language sql security invoker set search_path = ''
as $$
  update public.quiet_vaults
  set ciphertext = new_ciphertext, nonce = new_nonce,
      revision = revision + 1, updated_at = now()
  where user_id = (select auth.uid()) and revision = expected_revision
  returning *;
$$;
revoke all on function public.quiet_vault_save(bigint, text, text) from public, anon;
grant execute on function public.quiet_vault_save(bigint, text, text) to authenticated;
