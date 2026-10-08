-- Saldo negativo é permitido em compras; a consequência é disciplinar.
create table public.market_balance_penalties (
 id uuid primary key default gen_random_uuid(), club_id uuid not null references public.clubs(id),
 market_cycle_id uuid not null, transaction_id uuid not null references public.transactions(id),
 balance_at_breach bigint not null check(balance_at_breach<0),
 penalty text not null default 'all_market' check(penalty in ('all_market','one_purchase','lifted','expired')),
 revision integer not null default 1, reason text not null, created_at timestamptz not null default clock_timestamp(),
 reviewed_by uuid, updated_at timestamptz not null default clock_timestamp(), unique(club_id,market_cycle_id)
);
alter table public.market_balance_penalties enable row level security;
create policy balance_penalties_admin_read on public.market_balance_penalties for select to authenticated using(public.is_admin());
revoke all on public.market_balance_penalties from anon,authenticated;
grant select on public.market_balance_penalties to authenticated;

create function private.record_market_overdraft() returns trigger language plpgsql security definer set search_path='' as $$
declare v_cycle uuid;v_id uuid;v_name text;
begin
 if new.balance_after>=0 or new.amount>=0 or new.type not in ('negotiation_payment','external_transfer_purchase') then return new;end if;
 select market_cycle_id into v_cycle from public.market_windows order by updated_at desc nulls last limit 1;
 if v_cycle is null then raise exception 'Ciclo obrigatório para registrar saldo negativo';end if;
 insert into public.market_balance_penalties(club_id,market_cycle_id,transaction_id,balance_at_breach,reason)
 values(new.club_id,v_cycle,new.id,new.balance_after,'Saldo negativo após operação de mercado: bloqueio imediato por uma janela')
 on conflict(club_id,market_cycle_id) do nothing returning id into v_id;
 if v_id is null then return new;end if;
 select name into v_name from public.clubs where id=new.club_id;
 insert into public.audit_logs(actor_id,action,target,details) values(auth.uid(),'market_balance_penalty_applied',v_id::text,jsonb_build_object('club_id',new.club_id,'market_cycle_id',v_cycle,'transaction_id',new.id,'balance',new.balance_after,'penalty','all_market'));
 insert into public.notifications(user_id,category,title,body) select user_id,'transfer','Transfer ban por saldo negativo',v_name||': saldo '||new.balance_after||'. Todas as movimentações bloqueadas nesta janela. Revise a gravidade no painel.' from public.admin_users;
 return new;
end $$;
-- Deferred until transaction completion: the breach-causing contract/roster finishes first.
create constraint trigger record_market_overdraft after insert on public.transactions deferrable initially deferred for each row execute function private.record_market_overdraft();

create function private.check_market_balance_penalty(p_club uuid,p_cycle uuid,p_purchase_count integer default 0,p_exclude_n uuid default null,p_exclude_t uuid default null) returns void language plpgsql security definer set search_path='' as $$
declare v public.market_balance_penalties%rowtype;v_limit integer;v_usage integer;
begin
 select * into v from public.market_balance_penalties where club_id=p_club and market_cycle_id=p_cycle and penalty in ('all_market','one_purchase');
 if not found then return;end if;
 if v.penalty='all_market' then raise exception 'Transfer Ban: todas as movimentações bloqueadas nesta janela';end if;
 if p_purchase_count>0 then
  select max_transfers_per_club into v_limit from public.market_windows where market_cycle_id=p_cycle order by updated_at desc nulls last limit 1;
  v_usage:=(private.market_window_usage(p_club,p_cycle,p_exclude_n,p_exclude_t)->>'purchases')::integer;
  if v_limit is null or v_usage+p_purchase_count>greatest(v_limit-1,0) then raise exception 'Transfer Ban: uma compra retirada da quota desta janela';end if;
 end if;
end $$;

create function private.guard_market_balance_penalty() returns trigger language plpgsql security definer set search_path='' as $$
declare v_cycle uuid;
begin
 select market_cycle_id into v_cycle from public.market_windows order by updated_at desc nulls last limit 1;
 if tg_table_name='negotiations' then
  if new.status not in ('open','waiting','accepted','executed') then return new;end if;
  if tg_op='UPDATE' and old.status='executed' then return new;end if;
  perform 1 from public.clubs where id in(new.club_a_id,new.club_b_id) order by id for update;
  perform private.check_market_balance_penalty(new.club_a_id,v_cycle,case when new.type='transfer' then jsonb_array_length(new.player_ids_b) else 0 end,new.id);
  perform private.check_market_balance_penalty(new.club_b_id,v_cycle,0,new.id);
 elsif tg_table_name='transfers' then
  if new.status not in ('pending','approved') or new.source_negotiation_id is not null then return new;end if;
  if tg_op='UPDATE' and old.status='approved' then return new;end if;
  perform 1 from public.clubs where id in(new.from_club_id,new.to_club_id) order by id for update;
  perform private.check_market_balance_penalty(new.to_club_id,v_cycle,1,null,new.id);
  perform private.check_market_balance_penalty(new.from_club_id,v_cycle,0,null,new.id);
 end if;
 return new;
end $$;
create trigger zzz_balance_penalty before insert or update on public.negotiations for each row execute function private.guard_market_balance_penalty();
create trigger zzz_balance_penalty before insert or update on public.transfers for each row execute function private.guard_market_balance_penalty();

create function private.expire_market_balance_penalties() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.market_cycle_id is distinct from old.market_cycle_id then
  with expired as (update public.market_balance_penalties set penalty='expired',revision=revision+1,updated_at=clock_timestamp() where market_cycle_id is distinct from new.market_cycle_id and penalty in ('all_market','one_purchase') returning *)
  insert into public.audit_logs(actor_id,action,target,details) select auth.uid(),'market_balance_penalty_expired',id::text,jsonb_build_object('club_id',club_id,'served_market_cycle_id',market_cycle_id,'new_market_cycle_id',new.market_cycle_id) from expired;
 end if;return new;
end $$;
create trigger expire_market_balance_penalties after update of market_cycle_id on public.market_windows for each row execute function private.expire_market_balance_penalties();

create function public.admin_review_market_balance_penalty(p_id uuid,p_expected_revision integer,p_penalty text,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.market_balance_penalties%rowtype;
begin
 if auth.uid() is null or not coalesce(public.is_admin(),false) then raise exception 'Somente ADMs podem definir a gravidade';end if;
 perform private.require_admin_aal2_if_enrolled();
 if p_penalty not in ('all_market','one_purchase','lifted') or p_penalty is null or length(trim(coalesce(p_reason,''))) not between 15 and 500 then raise exception 'Informe penalidade e justificativa de 15 a 500 caracteres';end if;
 -- Same lock order as market operations; concurrent approval waits for this decision.
 perform 1 from public.clubs where id=(select club_id from public.market_balance_penalties where id=p_id) for update;
 select * into v from public.market_balance_penalties where id=p_id for update;
 if not found or v.revision is distinct from p_expected_revision then raise exception 'Penalidade mudou. Atualize o painel';end if;
 if v.penalty='expired' or v.market_cycle_id is distinct from (select market_cycle_id from public.market_windows order by updated_at desc nulls last limit 1) then raise exception 'Esta penalidade já terminou';end if;
 update public.market_balance_penalties set penalty=p_penalty,reason=trim(p_reason),revision=revision+1,reviewed_by=auth.uid(),updated_at=clock_timestamp() where id=p_id returning * into v;
 insert into public.audit_logs(actor_id,action,target,details) values(auth.uid(),'market_balance_penalty_reviewed',v.id::text,jsonb_build_object('penalty',p_penalty,'reason',trim(p_reason),'club_id',v.club_id,'revision',v.revision));
 return to_jsonb(v);
end $$;
revoke all on function public.admin_review_market_balance_penalty(uuid,integer,text,text) from public,anon;
grant execute on function public.admin_review_market_balance_penalty(uuid,integer,text,text) to authenticated;
revoke all on function private.record_market_overdraft(),private.check_market_balance_penalty(uuid,uuid,integer,uuid,uuid),private.guard_market_balance_penalty(),private.expire_market_balance_penalties() from public,anon,authenticated;
