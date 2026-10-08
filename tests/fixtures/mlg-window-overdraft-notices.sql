create table private.market_balance_penalty_deliveries (
 id uuid primary key default gen_random_uuid(),penalty_id uuid not null references public.market_balance_penalties(id),
 revision integer not null,group_id text not null,body text not null,lease_id uuid,lease_until timestamptz,delivered_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),unique(penalty_id,revision,group_id)
);
alter table private.market_balance_penalty_deliveries enable row level security;
revoke all on private.market_balance_penalty_deliveries from public,anon,authenticated;
create function private.claim_market_balance_penalty_notices(p_groups jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_groups text[];v_lease uuid:=gen_random_uuid();v_output jsonb;v_existing jsonb;
begin
 if jsonb_typeof(p_groups) is distinct from 'array' or jsonb_array_length(p_groups)>20 then raise exception 'Grupos administrativos inválidos';end if;
 select array_agg(value) into v_groups from jsonb_array_elements_text(p_groups) where value~'^[0-9-]{5,40}@g[.]us$';
 v_existing:=private.claim_whatsapp_market_admin_notices(p_groups);
 insert into private.market_balance_penalty_deliveries(penalty_id,revision,group_id,body)
 select p.id,p.revision,g,'🚫 Transfer Ban — '||c.name||'. Saldo na ocorrência: €'||p.balance_at_breach||'. '||case p.penalty when 'all_market' then 'Todas as movimentações bloqueadas nesta janela.' when 'one_purchase' then 'Uma compra retirada da quota desta janela.' when 'expired' then 'Penalidade encerrada: janela cumprida.' else 'Penalidade liberada pelos ADMs.' end||' Motivo: '||p.reason||' Confira na plataforma: https://v0-mlg01.vercel.app/admin?mlg_target=whatsapp-market'
 from public.market_balance_penalties p join public.clubs c on c.id=p.club_id cross join unnest(v_groups) g
 on conflict do nothing;
 update private.market_balance_penalty_deliveries d set delivered_at=clock_timestamp() from public.market_balance_penalties p where d.penalty_id=p.id and d.revision<>p.revision and d.delivered_at is null;
 with picked as(select id from private.market_balance_penalty_deliveries where delivered_at is null and group_id=any(v_groups) and (lease_until is null or lease_until<clock_timestamp()) order by created_at limit 10 for update skip locked),
 leased as(update private.market_balance_penalty_deliveries d set lease_id=v_lease,lease_until=clock_timestamp()+interval '90 seconds' from picked where d.id=picked.id returning d.*)
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'lease',lease_id,'group',group_id,'body',body)),'[]') into v_output from leased;
 return jsonb_build_object('notices',coalesce(v_existing->'notices','[]')||v_output);
end $$;
revoke all on function private.claim_market_balance_penalty_notices(jsonb) from public,anon,authenticated;
