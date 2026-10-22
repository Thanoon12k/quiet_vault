-- Google-only unlock: wrapping secrets are encrypted at rest by Supabase Vault.
-- Only account-bound helpers in an unexposed schema can retrieve them.
alter table public.quiet_vaults add column unlock_mode text not null default 'master'
  check (unlock_mode in ('master','managed'));
create schema quiet_vault_private;
revoke all on schema quiet_vault_private from public, anon, authenticated;
grant usage on schema quiet_vault_private to authenticated;
create table quiet_vault_private.managed_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,
  secret_id uuid not null unique references vault.secrets(id)
);
alter table quiet_vault_private.managed_keys enable row level security;
create policy own_key_mapping on quiet_vault_private.managed_keys
for select to authenticated using ((select auth.uid())=user_id);
revoke all on quiet_vault_private.managed_keys from public, anon, authenticated;

create function quiet_vault_private.managed_key(create_if_missing boolean default false)
returns text language plpgsql security definer set search_path=''
as $$
declare owner_id uuid := auth.uid(); secret_ref uuid; secret_value text; current_mode text;
begin
  if owner_id is null then raise exception 'Sign in required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('quiet-vault:'||owner_id::text,0));
  select unlock_mode into current_mode from public.quiet_vaults where user_id=owner_id;
  if current_mode='master' and not create_if_missing then return null; end if;
  select secret_id into secret_ref from quiet_vault_private.managed_keys where user_id=owner_id;
  if secret_ref is null and create_if_missing then
    secret_value := encode(extensions.gen_random_bytes(32),'base64');
    secret_ref := vault.create_secret(secret_value,'quiet-vault-'||owner_id::text,'Account-managed Quiet Vault wrapping secret');
    insert into quiet_vault_private.managed_keys(user_id,secret_id) values(owner_id,secret_ref);
  end if;
  if secret_ref is null then return null; end if;
  select decrypted_secret into secret_value from vault.decrypted_secrets where id=secret_ref;
  return secret_value;
end $$;
revoke all on function quiet_vault_private.managed_key(boolean) from public, anon;
grant execute on function quiet_vault_private.managed_key(boolean) to authenticated;

create function public.quiet_vault_managed_key(create_if_missing boolean default false)
returns text language sql security invoker set search_path=''
as $$ select quiet_vault_private.managed_key(create_if_missing); $$;
revoke all on function public.quiet_vault_managed_key(boolean) from public, anon;
grant execute on function public.quiet_vault_managed_key(boolean) to authenticated;

create function quiet_vault_private.enable_managed(expected_revision bigint,new_salt text,new_wrapped_key text,new_wrap_nonce text)
returns setof public.quiet_vaults language plpgsql security definer set search_path=''
as $$
declare owner_id uuid := auth.uid(); current_row public.quiet_vaults;
begin
  if owner_id is null then raise exception 'Sign in required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('quiet-vault:'||owner_id::text,0));
  select * into current_row from public.quiet_vaults where user_id=owner_id for update;
  if not found or current_row.revision<>expected_revision then return; end if;
  if current_row.unlock_mode<>'master' then raise exception 'Vault already uses managed unlock'; end if;
  if not exists(select 1 from quiet_vault_private.managed_keys where user_id=owner_id) then
    raise exception 'Prepare managed key first';
  end if;
  return query update public.quiet_vaults set salt=new_salt,wrapped_key=new_wrapped_key,
    wrap_nonce=new_wrap_nonce,unlock_mode='managed',revision=revision+1,updated_at=now()
    where user_id=owner_id returning *;
end $$;
revoke all on function quiet_vault_private.enable_managed(bigint,text,text,text) from public, anon;
grant execute on function quiet_vault_private.enable_managed(bigint,text,text,text) to authenticated;
create function public.quiet_vault_enable_managed(expected_revision bigint,new_salt text,new_wrapped_key text,new_wrap_nonce text)
returns setof public.quiet_vaults language sql security invoker set search_path=''
as $$ select * from quiet_vault_private.enable_managed(expected_revision,new_salt,new_wrapped_key,new_wrap_nonce); $$;
revoke all on function public.quiet_vault_enable_managed(bigint,text,text,text) from public, anon;
grant execute on function public.quiet_vault_enable_managed(bigint,text,text,text) to authenticated;
