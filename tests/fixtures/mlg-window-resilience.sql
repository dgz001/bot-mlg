-- A pause waits for financial transactions already in progress. Capture remains active.
create table public.whatsapp_market_safety (
 id boolean primary key default true check(id), paused boolean not null default false,
 revision integer not null default 1, reason text not null default '', changed_by uuid references auth.users(id),
 changed_at timestamptz not null default clock_timestamp()
);
insert into public.whatsapp_market_safety(id) values(true);
alter table public.whatsapp_market_safety enable row level security;
revoke all on public.whatsapp_market_safety from public,anon,authenticated;
grant select on public.whatsapp_market_safety to authenticated;
create policy market_safety_admin_read on public.whatsapp_market_safety for select to authenticated using((select public.is_admin()));

create function private.require_market_not_paused() returns void language plpgsql security definer set search_path='' as $$
declare v_paused boolean;
begin
 select paused into v_paused from public.whatsapp_market_safety where id for share;
 if v_paused is distinct from false then raise exception 'Aprovações pausadas por emergência. As propostas continuam salvas';end if;
end$$;
create function public.admin_set_whatsapp_market_pause(p_paused boolean,p_expected_revision integer,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.whatsapp_market_safety%rowtype;v_before jsonb;
begin
 if auth.uid() is null or not coalesce(public.is_admin(),false) then raise exception 'Somente ADMs podem controlar a pausa';end if;
 perform private.require_admin_aal2_if_enrolled();
 if p_paused is null or length(trim(coalesce(p_reason,''))) not between 15 and 500 then raise exception 'Informe um motivo de 15 a 500 caracteres';end if;
 select * into v from public.whatsapp_market_safety where id for update;
 if v.revision is distinct from p_expected_revision then raise exception 'Outro ADM alterou a pausa. Atualize o painel';end if;
 v_before:=to_jsonb(v);
 if v.paused=p_paused then return to_jsonb(v)||jsonb_build_object('success',true,'duplicate',true);end if;
 update public.whatsapp_market_safety set paused=p_paused,revision=revision+1,reason=trim(p_reason),changed_by=auth.uid(),changed_at=clock_timestamp() where id returning * into v;
 insert into public.audit_logs(actor_id,action,target,details,before_value,after_value) values(auth.uid(),'whatsapp_market_emergency_pause','whatsapp_market_safety',jsonb_build_object('reason',trim(p_reason)),v_before,to_jsonb(v));
 insert into public.notifications(user_id,category,title,body) select a.user_id,'market',case when p_paused then 'Aprovações pausadas' else 'Aprovações retomadas' end,trim(p_reason) from public.admin_users a;
 return to_jsonb(v)||jsonb_build_object('success',true);
end$$;

-- One active contract owns each player/free agent. No roster mutation is used to reserve it.
create table private.whatsapp_market_asset_reservations (
 asset_kind text not null check(asset_kind in('player','free_agent')),asset_id uuid not null,
 source_type text not null check(source_type in('negotiation','transfer')),source_id uuid not null,
 created_at timestamptz not null default clock_timestamp(),primary key(asset_kind,asset_id)
);
alter table private.whatsapp_market_asset_reservations enable row level security;
revoke all on private.whatsapp_market_asset_reservations from public,anon,authenticated;
create index market_reservations_source on private.whatsapp_market_asset_reservations(source_type,source_id);

-- Correctly exclude the transfer's own hold, not an unrelated auction.
alter function private.club_financial_commitment(uuid,uuid,uuid,uuid) volatile;
create function private.market_other_commitment(p_club uuid,p_negotiation uuid default null,p_transfer uuid default null) returns bigint language sql volatile security definer set search_path='' as $$
 select greatest(0,private.club_financial_commitment(p_club,p_negotiation,null,null)-coalesce((select t.price from public.transfers t where t.id=p_transfer and t.to_club_id=p_club and t.status='pending' and t.source_negotiation_id is null and t.deleted_at is null and t.market_cycle_id=(select market_cycle_id from public.market_windows order by updated_at desc nulls last limit 1)),0));
$$;
create function private.reserve_market_contract_assets() returns trigger language plpgsql security definer set search_path='' as $$
declare v_type text;v_assets uuid[]:='{}';v_agent uuid;v_clubs uuid[];v_active boolean;v_due bigint;v_club uuid;v_asset uuid;v_owner uuid;v_key text;v_cash_a bigint;v_cash_b bigint;v_buyer uuid;
begin
 v_type:=case when tg_table_name='negotiations' then 'negotiation' else 'transfer' end;
 if tg_op='DELETE' then delete from private.whatsapp_market_asset_reservations where source_type=v_type and source_id=old.id;return old;end if;
 if v_type='negotiation' then
  v_cash_a:=new.cash_from_a;v_cash_b:=new.cash_from_b;v_buyer:=new.club_a_id;v_active:=new.status in('open','waiting','accepted');v_clubs:=array[new.club_a_id,new.club_b_id];
  select coalesce(array_agg(distinct value::uuid),'{}') into v_assets from jsonb_array_elements_text(coalesce(new.player_ids_a,'[]')||coalesce(new.player_ids_b,'[]'));
 else
  v_cash_a:=new.price;v_cash_b:=0;v_buyer:=new.to_club_id;v_active:=new.status='pending' and new.source_negotiation_id is null and new.deleted_at is null;v_clubs:=array[new.from_club_id,new.to_club_id];v_agent:=new.free_agent_id;
  if new.player_id is not null then v_assets:=array[new.player_id];end if;
 end if;
 if v_active or (tg_op='UPDATE' and new.status is distinct from old.status and new.status in('executed','approved')) or (tg_op='INSERT' and new.status='approved') then perform private.require_market_not_paused();end if;
 if not v_active then delete from private.whatsapp_market_asset_reservations where source_type=v_type and source_id=new.id;return new;end if;
 perform 1 from public.clubs where id=any(v_clubs) order by id for update;
 perform 1 from public.players where id=any(v_assets) order by id for update;
 if v_agent is not null then perform 1 from public.free_agents where id=v_agent for update;end if;
 if v_type='negotiation' then
  if (select count(*) from public.players where id in(select value::uuid from jsonb_array_elements_text(new.player_ids_a)) and club_id=new.club_a_id and roster_active and deleted_at is null)<>jsonb_array_length(new.player_ids_a) or (select count(*) from public.players where id in(select value::uuid from jsonb_array_elements_text(new.player_ids_b)) and club_id=new.club_b_id and roster_active and deleted_at is null)<>jsonb_array_length(new.player_ids_b) then raise exception 'Elenco mudou antes da reserva. Confira os jogadores';end if;
 elsif v_agent is not null then
  if not exists(select 1 from public.free_agents where id=v_agent and status='available') then raise exception 'Carta externa indisponível para reserva';end if;
 elsif not exists(select 1 from public.players where id=new.player_id and club_id=new.from_club_id and roster_active and deleted_at is null) then raise exception 'Jogador indisponível para reserva';end if;
 for v_club in select distinct x from unnest(v_clubs) x where x is not null order by x loop
  v_due:=case when v_club=v_buyer then greatest(v_cash_a-v_cash_b,0) else greatest(v_cash_b-v_cash_a,0) end;
  if v_due>0 and (select balance from public.clubs where id=v_club and deleted_at is null)<private.market_other_commitment(v_club,case when v_type='negotiation' then new.id end,case when v_type='transfer' then new.id end)+v_due then raise exception 'Saldo disponível insuficiente para reservar esta proposta';end if;
 end loop;
 delete from private.whatsapp_market_asset_reservations where source_type=v_type and source_id=new.id and not ((asset_kind='player' and asset_id=any(v_assets)) or (asset_kind='free_agent' and coalesce(asset_id=v_agent,false)));
 for v_asset,v_key in select x,'player' from unnest(v_assets) x union all select v_agent,'free_agent' where v_agent is not null order by 2,1 loop
  insert into private.whatsapp_market_asset_reservations(asset_kind,asset_id,source_type,source_id) values(v_key,v_asset,v_type,new.id) on conflict(asset_kind,asset_id) do nothing;
  select source_id into v_owner from private.whatsapp_market_asset_reservations where asset_kind=v_key and asset_id=v_asset and source_type=v_type and source_id=new.id;
  if not found then raise exception 'Jogador já reservado por outra proposta. Rejeite ou cancele a anterior antes de continuar';end if;
 end loop;
 return new;
end$$;
-- Run after existing initialization/quota checks, within the same transaction.
create trigger zzzz_reserve_negotiation_assets before insert or update or delete on public.negotiations for each row execute function private.reserve_market_contract_assets();
create trigger zzzz_reserve_transfer_assets before insert or update or delete on public.transfers for each row execute function private.reserve_market_contract_assets();

-- These constraints are a final backstop even if the client repeats a command.
create unique index market_settlement_source_once on public.whatsapp_market_settlement_snapshots(source_type,source_id);
create unique index market_financial_effect_once on public.transactions(club_id,description)
 where type in('negotiation_payment','negotiation_receipt','external_transfer_purchase') and description ~ '^(Pagamento da negociação |Recebimento da negociação |Contratação assinada |Receita da contratação assinada )[0-9a-f-]{36}$';

revoke all on function private.require_market_not_paused(),private.market_other_commitment(uuid,uuid,uuid),private.reserve_market_contract_assets() from public,anon,authenticated;
revoke all on function public.admin_set_whatsapp_market_pause(boolean,integer,text) from public,anon;
grant execute on function public.admin_set_whatsapp_market_pause(boolean,integer,text) to authenticated;
