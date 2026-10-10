create table public.roster_collection_settings(id boolean primary key default true check(id),enabled boolean not null default false,group_id text,revision integer not null default 1);
insert into public.roster_collection_settings(id) values(true);
create table public.roster_collection_runs(id uuid primary key default gen_random_uuid(),cycle_id uuid not null,created_at timestamptz not null default clock_timestamp());
create table public.roster_collection_deliveries(run_id uuid references public.roster_collection_runs(id),club_id uuid references public.clubs(id),status text not null check(status in('requested','incomplete','ready','delivered')),updated_at timestamptz not null default clock_timestamp(),primary key(run_id,club_id));
alter table public.roster_collection_settings enable row level security;
alter table public.roster_collection_runs enable row level security;
alter table public.roster_collection_deliveries enable row level security;
revoke all on public.roster_collection_settings,public.roster_collection_runs,public.roster_collection_deliveries from public,anon,authenticated;
grant select on public.roster_collection_settings,public.roster_collection_runs,public.roster_collection_deliveries to authenticated;
create policy roster_settings_adm on public.roster_collection_settings for select to authenticated using(public.is_admin());
create policy roster_runs_adm on public.roster_collection_runs for select to authenticated using(public.is_admin());
create policy roster_deliveries_adm on public.roster_collection_deliveries for select to authenticated using(public.is_admin());
create function public.admin_configure_roster_collection(p_enabled boolean,p_group text,p_revision integer) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not coalesce(public.is_admin(),false) then raise exception 'Somente ADMs';end if;
 perform private.require_admin_aal2_if_enrolled();
 if p_enabled is null or (p_enabled and (p_group is null or p_group !~ '^[0-9-]{5,40}@g[.]us$')) then raise exception 'Escolha o grupo de elencos';end if;
 update public.roster_collection_settings set enabled=p_enabled,group_id=p_group,revision=revision+1 where id and revision=p_revision;
 if not found then raise exception 'Configuração mudou; atualize a página';end if;
 insert into public.audit_logs(actor_id,action,target,details) values(auth.uid(),'roster_collection_configured','settings',jsonb_build_object('enabled',p_enabled,'group',p_group));
 return jsonb_build_object('success',true);
end$$;
revoke all on function public.admin_configure_roster_collection(boolean,text,integer) from public,anon;
grant execute on function public.admin_configure_roster_collection(boolean,text,integer) to authenticated;
create function private.start_roster_collection_on_close() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (old.transfer_window_open or old.trade_window_open) and not (new.transfer_window_open or new.trade_window_open) and (select enabled from public.roster_collection_settings where id) then
  if (select count(*) from public.whatsapp_market_club_directory)<>25 then raise exception 'Confira os 25 responsáveis antes de encerrar';end if;
  insert into public.roster_collection_runs(cycle_id) values(new.market_cycle_id);
 end if;return new;
end$$;
revoke all on function private.start_roster_collection_on_close() from public,anon,authenticated;
create trigger roster_collection_window_closed after update of transfer_window_open,trade_window_open on public.market_windows for each row execute function private.start_roster_collection_on_close();
create function private.roster_collection_config() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('enabled',s.enabled,'group',s.group_id,'run',(select id from public.roster_collection_runs order by created_at desc limit 1),'opened',(select transfer_window_open or trade_window_open from public.market_windows order by updated_at desc limit 1),'directory',case when s.enabled then coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'recipient',d.phone||'@s.whatsapp.net')) from public.whatsapp_market_club_directory d join public.clubs c on c.id=d.club_id where c.deleted_at is null),'[]'::jsonb) else '[]'::jsonb end) from public.roster_collection_settings s where id
$$;
revoke all on function private.roster_collection_config() from public,anon,authenticated;
create function private.roster_collection_progress(p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p->>'status' not in('requested','incomplete','ready','delivered') or not exists(select 1 from public.roster_collection_runs where id=(p->>'run')::uuid) or not exists(select 1 from public.whatsapp_market_club_directory where club_id=(p->>'club')::uuid) then raise exception 'Entrega inválida';end if;
 insert into public.roster_collection_deliveries(run_id,club_id,status) values((p->>'run')::uuid,(p->>'club')::uuid,p->>'status') on conflict(run_id,club_id) do update set status=excluded.status,updated_at=clock_timestamp() where public.roster_collection_deliveries.status<>'delivered' or excluded.status='delivered';
 return jsonb_build_object('success',true);
end$$;
revoke all on function private.roster_collection_progress(jsonb) from public,anon,authenticated;
