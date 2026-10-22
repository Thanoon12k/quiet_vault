-- Run as postgres. Test writes exist only inside this rolled-back transaction.
begin;
create temporary table quiet_vault_test_users on commit drop as
select id from auth.users u where not exists (select 1 from public.quiet_vaults v where v.user_id=u.id)
order by id limit 2;
do $$ begin
  if (select count(*) from quiet_vault_test_users) <> 2 then
    raise exception 'Need two existing users without vaults for this transactional isolation test';
  end if;
end $$;
select set_config('quiet_test.owner', (select id::text from quiet_vault_test_users order by id limit 1), true);
select set_config('quiet_test.other', (select id::text from quiet_vault_test_users order by id offset 1 limit 1), true);
insert into public.quiet_vaults(user_id,iterations,salt,wrapped_key,wrap_nonce,ciphertext,nonce)
select id,600000,repeat('A',24),repeat('A',64),repeat('A',16),repeat('A',32),repeat('A',16)
from quiet_vault_test_users;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('quiet_test.owner'), 'role', 'authenticated')::text, true);
do $$ declare amount integer; begin
  select count(*) into amount from public.quiet_vaults;
  if amount <> 1 then raise exception 'RLS leaked another vault'; end if;
  select count(*) into amount from public.quiet_vault_save(1,repeat('B',32),repeat('B',16));
  if amount <> 1 then raise exception 'Owner write failed'; end if;
  select count(*) into amount from public.quiet_vault_save(1,repeat('C',32),repeat('C',16));
  if amount <> 0 then raise exception 'Stale write was accepted'; end if;
  update public.quiet_vaults set revision=9 where user_id=current_setting('quiet_test.other')::uuid;
  get diagnostics amount = row_count;
  if amount <> 0 then raise exception 'Cross-account update succeeded'; end if;
  begin
    update public.quiet_vaults set salt=repeat('B',24);
    raise exception 'Immutable key metadata was writable';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.quiet_vaults(user_id,iterations,salt,wrapped_key,wrap_nonce,ciphertext,nonce)
    values (gen_random_uuid(),600000,repeat('A',24),repeat('A',64),repeat('A',16),repeat('A',32),repeat('A',16));
    raise exception 'Cross-account insert succeeded';
  exception when insufficient_privilege then null;
  end;
end $$;
set local role anon;
do $$ begin
  begin
    perform * from public.quiet_vaults;
    raise exception 'Anonymous read succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.quiet_vault_save(2,repeat('D',32),repeat('D',16));
    raise exception 'Anonymous RPC succeeded';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
rollback;
select 'PASS: owner access, cross-account isolation, immutable wrapping keys, stale-write rejection, anonymous denial; test writes rolled back' as verification;
