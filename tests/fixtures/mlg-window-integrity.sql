-- Exact settlement evidence and compensating corrections. Original contracts
-- and ledger rows remain immutable; a corrected source is excluded from quotas.
create table public.whatsapp_market_settlement_snapshots(
 inbox_id uuid primary key references public.whatsapp_market_inbox(id),
 source_type text not null check(source_type in('negotiation','transfer')),
 source_id uuid not null, snapshot jsonb not null, captured_at timestamptz not null default clock_timestamp()
);
create table public.whatsapp_market_corrections(
 id uuid primary key default gen_random_uuid(), request_id uuid not null unique,
 inbox_id uuid not null unique references public.whatsapp_market_settlement_snapshots(inbox_id),
 reason text not null check(length(trim(reason)) between 15 and 500),
 before_state jsonb not null,after_state jsonb not null, compensation_ids uuid[] not null,
 corrected_by uuid not null references auth.users(id),created_at timestamptz not null default clock_timestamp()
);
alter table public.whatsapp_market_settlement_snapshots enable row level security;
alter table public.whatsapp_market_corrections enable row level security;
revoke all on public.whatsapp_market_settlement_snapshots,public.whatsapp_market_corrections from public,anon,authenticated;
grant select on public.whatsapp_market_settlement_snapshots,public.whatsapp_market_corrections to authenticated;
create policy snapshot_admin_read on public.whatsapp_market_settlement_snapshots for select to authenticated using((select public.is_admin()));
create policy correction_admin_read on public.whatsapp_market_corrections for select to authenticated using((select public.is_admin()));
create function private.protect_whatsapp_market_evidence() returns trigger language plpgsql set search_path='' as $$begin raise exception 'Histórico de liquidação e correção é imutável';end$$;
create trigger immutable_market_snapshot before update or delete on public.whatsapp_market_settlement_snapshots for each row execute function private.protect_whatsapp_market_evidence();
create trigger immutable_market_correction before update or delete on public.whatsapp_market_corrections for each row execute function private.protect_whatsapp_market_evidence();

create function private.whatsapp_market_source_corrected(p_type text,p_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.whatsapp_market_corrections c join public.whatsapp_market_settlement_snapshots s on s.inbox_id=c.inbox_id where (s.source_type=p_type and s.source_id=p_id) or (p_type='transfer' and s.source_type='negotiation' and exists(select 1 from public.transfers t where t.id=p_id and t.source_negotiation_id=s.source_id)));
$$;
create function private.capture_whatsapp_market_settlement() returns trigger language plpgsql security definer set search_path='' as $$
declare v_players jsonb;v_ledger jsonb;v_agent jsonb;v_type text;v_source uuid;t public.transfers%rowtype;v_expected integer;
begin
 if new.status<>'settled' or (tg_op='UPDATE' and old.status='settled') then return new;end if;
 v_type:=case when new.transfer_id is not null then 'transfer' else 'negotiation' end;v_source:=coalesce(new.transfer_id,new.negotiation_id);
 if v_source is null then raise exception 'Liquidação sem contrato oficial';end if;
 if v_type='transfer' then
  select * into t from public.transfers where id=v_source and status='approved';
  if not found or t.to_club_id is distinct from new.to_club_id or t.price is distinct from new.amount or t.player_id is null then raise exception 'Liquidação externa não corresponde ao contrato';end if;
  select jsonb_agg(jsonb_build_object('id',p.id,'return_club_id',new.from_club_id,'state',to_jsonb(p))) into v_players from public.players p where p.id=t.player_id and p.club_id=new.to_club_id and p.roster_active;
  select to_jsonb(a) into v_agent from public.free_agents a where a.id=t.free_agent_id;
 else
  if not exists(select 1 from public.negotiations n where n.id=v_source and n.status='executed' and n.club_a_id=new.to_club_id and n.club_b_id=new.from_club_id and n.player_ids_a=to_jsonb(new.player_ids_to) and n.player_ids_b=to_jsonb(new.player_ids_from) and n.cash_from_a=new.amount and n.cash_from_b=0) then raise exception 'Liquidação não corresponde à negociação';end if;
  select jsonb_agg(jsonb_build_object('id',p.id,'return_club_id',case when p.id=any(new.player_ids_from) then new.from_club_id else new.to_club_id end,'state',to_jsonb(p)) order by p.id) into v_players from public.players p where p.id=any(new.player_ids_from||new.player_ids_to) and p.roster_active;
  if jsonb_array_length(coalesce(v_players,'[]'))<>cardinality(new.player_ids_from||new.player_ids_to) then raise exception 'Elenco da liquidação incompleto';end if;
 end if;
 if v_players is null then raise exception 'Liquidação sem jogador ativo';end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) into v_ledger from public.transactions x where
 (v_type='negotiation' and x.description in('Pagamento da negociação '||v_source,'Recebimento da negociação '||v_source)) or
 (v_type='transfer' and x.description in('Contratação assinada '||v_source,'Receita da contratação assinada '||v_source));
 v_expected:=case when new.amount=0 then 0 when new.from_club_id is null then 1 else 2 end;
 if jsonb_array_length(v_ledger)<>v_expected or (new.amount>0 and (not exists(select 1 from jsonb_array_elements(v_ledger) e where (e->>'club_id')::uuid=new.to_club_id and (e->>'amount')::bigint=-new.amount) or (new.from_club_id is not null and not exists(select 1 from jsonb_array_elements(v_ledger) e where (e->>'club_id')::uuid=new.from_club_id and (e->>'amount')::bigint=new.amount)))) then raise exception 'Caixa da liquidação não confere com o contrato';end if;
 insert into public.whatsapp_market_settlement_snapshots(inbox_id,source_type,source_id,snapshot) values(new.id,v_type,v_source,jsonb_build_object('proposal',to_jsonb(new),'players',v_players,'ledger',v_ledger,'agent',v_agent));
 return new;
end$$;
create trigger capture_market_settlement after insert or update of status on public.whatsapp_market_inbox for each row execute function private.capture_whatsapp_market_settlement();

create function public.admin_preview_whatsapp_market_approval(p_id uuid,p_expected_revision integer) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.whatsapp_market_inbox%rowtype;w public.market_windows%rowtype;v_clubs jsonb;v_players jsonb;v_state jsonb;v_actor jsonb;
begin
 if auth.uid() is null or not coalesce(public.is_admin(),false) then raise exception 'Somente ADMs podem conferir propostas';end if;
 select * into r from public.whatsapp_market_inbox where id=p_id;
 if not found or r.status<>'awaiting_signatures' or r.revision is distinct from p_expected_revision then raise exception 'Proposta mudou: atualize a conferência';end if;
 select * into w from public.market_windows order by updated_at desc nulls last limit 1;
 if not found or r.market_cycle_id is distinct from w.market_cycle_id or w.maintenance_mode or w.read_only_mode or (r.kind='trade' and not w.trade_window_open) or (r.kind='transfer' and not w.transfer_window_open) then raise exception 'A janela desta proposta não está liberada';end if;
 v_actor:=coalesce(private.whatsapp_market_directory_actor(r.participant_id),case when r.participant_id ~ '^[0-9]+@lid$' then private.whatsapp_market_directory_actor(r.parsed->>'directoryPhone') end);
 select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'balance',c.balance,'available',c.balance-private.club_financial_commitment(c.id,r.negotiation_id,r.transfer_id,null),'delta',case when c.id=r.to_club_id then -r.amount else r.amount end,'after',c.balance+case when c.id=r.to_club_id then -r.amount else r.amount end) order by c.id) into v_clubs from public.clubs c where c.id in(r.from_club_id,r.to_club_id) and c.deleted_at is null;
 if r.to_club_id is null or jsonb_array_length(coalesce(v_clubs,'[]'))<>case when r.from_club_id is null then 1 else 2 end then raise exception 'Clubes oficiais não confirmados';end if;
 if exists(select 1 from jsonb_array_elements(v_clubs) c where (c->>'delta')::bigint<0 and (c->>'available')::bigint<-(c->>'delta')::bigint) then raise exception 'Saldo disponível insuficiente';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'club_id',p.club_id,'roster_active',p.roster_active,'market_status',p.market_status,'destination',case when p.id=any(r.player_ids_from) then r.to_club_id else r.from_club_id end) order by p.id),'[]'::jsonb) into v_players from public.players p where p.id=any(r.player_ids_from||r.player_ids_to);
 if r.transfer_id is not null then
  if r.free_agent_id is null then raise exception 'Jogador externo não associado';end if;
  select jsonb_build_array(jsonb_build_object('id',a.id,'name',a.name,'week',a.week_rating,'price',a.market_value,'status',a.status,'destination',r.to_club_id)) into v_players from public.free_agents a where a.id=r.free_agent_id;
  if v_players is null then raise exception 'Jogador externo não encontrado';end if;
 end if;
 v_state:=jsonb_build_object('proposal',to_jsonb(r),'terms',private.market_contract_snapshot(case when r.transfer_id is not null then 'transfer' else 'negotiation' end,coalesce(r.transfer_id,r.negotiation_id)),'clubs',v_clubs,'players',v_players,'official_actor',v_actor,'members_released',(select members_released from public.platform_member_access where id));
 return v_state||jsonb_build_object('success',true,'preview_hash',md5(v_state::text),'generated_at',now());
end$$;
create function public.admin_approve_whatsapp_market_with_preview(p_id uuid,p_expected_revision integer,p_preview_hash text,p_buyer_confirmed boolean default false,p_seller_confirmed boolean default false,p_reason text default '') returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.whatsapp_market_inbox%rowtype;v jsonb;
begin
 if auth.uid() is null or not coalesce(public.is_admin(),false) then raise exception 'Somente ADMs podem concluir propostas';end if;perform private.require_admin_aal2_if_enrolled();
 select * into r from public.whatsapp_market_inbox where id=p_id for update;
 if r.status='settled' then return jsonb_build_object('success',true,'duplicate',true);end if;
 if r.negotiation_id is not null then perform 1 from public.negotiations where id=r.negotiation_id for update;end if;
 if r.transfer_id is not null then perform 1 from public.transfers where id=r.transfer_id for update;end if;
 perform 1 from public.clubs where id in(r.from_club_id,r.to_club_id) order by id for update;
 perform 1 from public.players where id=any(r.player_ids_from||r.player_ids_to) order by id for update;
 if r.free_agent_id is not null then perform 1 from public.free_agents where id=r.free_agent_id for update;end if;
 v:=public.admin_preview_whatsapp_market_approval(p_id,p_expected_revision);
 if p_preview_hash is null or p_preview_hash is distinct from v->>'preview_hash' then raise exception 'Saldos ou termos mudaram. Gere um novo resumo antes de aprovar';end if;
 if exists(select 1 from public.platform_member_access where id and not members_released) then return public.admin_approve_whatsapp_market_without_member_accounts(p_id,p_expected_revision,p_buyer_confirmed,p_seller_confirmed,p_reason);end if;
 return public.admin_approve_whatsapp_market_proposal(p_id,p_expected_revision);
end$$;

create function public.admin_correct_whatsapp_market_settlement(p_id uuid,p_request_id uuid,p_reason text,p_confirm boolean default false,p_expected_hash text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.whatsapp_market_inbox%rowtype;s public.whatsapp_market_settlement_snapshots%rowtype;c public.whatsapp_market_corrections%rowtype;v_players jsonb;v_clubs jsonb;v_agent jsonb;v_before jsonb;v_after jsonb;v_hash text;x jsonb;v_tx uuid;v_ids uuid[]:='{}';
begin
 if auth.uid() is null or not coalesce(public.is_admin(),false) then raise exception 'Somente ADMs podem corrigir liquidações';end if;perform private.require_admin_aal2_if_enrolled();
 if p_id is null or p_request_id is null or length(trim(coalesce(p_reason,''))) not between 15 and 500 then raise exception 'Informe a operação e um motivo de 15 a 500 caracteres';end if;
 perform pg_advisory_xact_lock(hashtextextended('whatsapp-market-correction:'||p_id,0));
 if exists(select 1 from public.whatsapp_market_corrections where request_id=p_request_id and inbox_id<>p_id) then raise exception 'Solicitação de correção pertence a outra operação';end if;
 select * into c from public.whatsapp_market_corrections where inbox_id=p_id;
 if found then return jsonb_build_object('success',true,'confirmed',true,'duplicate',true,'correction_id',c.id,'before',c.before_state,'after',c.after_state);end if;
 select * into r from public.whatsapp_market_inbox where id=p_id for update;
 select * into s from public.whatsapp_market_settlement_snapshots where inbox_id=p_id;
 if r.status is distinct from 'settled' or s.inbox_id is null then raise exception 'Liquidação sem snapshot seguro: requer conferência manual';end if;
 if r.negotiation_id is not null then perform 1 from public.negotiations where id=r.negotiation_id for update;end if;
 if r.transfer_id is not null then perform 1 from public.transfers where id=r.transfer_id for update;end if;
 perform 1 from public.clubs where id in(r.from_club_id,r.to_club_id) order by id for update;
 perform 1 from public.players where id in(select (e->>'id')::uuid from jsonb_array_elements(s.snapshot->'players') e) order by id for update;
 if r.free_agent_id is not null then perform 1 from public.free_agents where id=r.free_agent_id for update;end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'return_club_id',e->'return_club_id','state',to_jsonb(p)) order by p.id),'[]'::jsonb) into v_players from jsonb_array_elements(s.snapshot->'players') e join public.players p on p.id=(e->>'id')::uuid;
 if v_players is distinct from s.snapshot->'players' then raise exception 'Reversão bloqueada: jogador ou elenco mudou depois da aprovação';end if;
 if exists(select 1 from public.transfers t where t.player_id in(select (e->>'id')::uuid from jsonb_array_elements(v_players) e) and t.created_at>s.captured_at and t.status in('pending','approved') and t.deleted_at is null and not private.whatsapp_market_source_corrected('transfer',t.id)) or exists(select 1 from public.negotiations n where n.id is distinct from r.negotiation_id and n.status in('open','waiting','accepted') and exists(select 1 from jsonb_array_elements(v_players) e where n.player_ids_a ? (e->>'id') or n.player_ids_b ? (e->>'id'))) or exists(select 1 from public.club_loan_contracts l where l.status in('proposed','pending_admin','active') and exists(select 1 from jsonb_array_elements(v_players) e where (e->>'id')::uuid in(l.loaned_player_id,l.collateral_player_id))) then raise exception 'Reversão bloqueada por uma operação posterior ou empréstimo';end if;
 select to_jsonb(a) into v_agent from public.free_agents a where id=r.free_agent_id;
 if v_agent is distinct from s.snapshot->'agent' and not (v_agent is null and s.snapshot->'agent'='null'::jsonb) then raise exception 'Cadastro externo mudou depois da aprovação';end if;
 select jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'balance',a.balance,'available',a.balance-private.club_financial_commitment(a.id,null,null,null),'delta',coalesce((select -sum((e->>'amount')::bigint) from jsonb_array_elements(s.snapshot->'ledger') e where (e->>'club_id')::uuid=a.id),0)) order by a.id) into v_clubs from public.clubs a where a.id in(r.from_club_id,r.to_club_id) and a.deleted_at is null;
 if jsonb_array_length(coalesce(v_clubs,'[]'))<>case when r.from_club_id is null then 1 else 2 end then raise exception 'Clube indisponível para correção';end if;
 if exists(select 1 from jsonb_array_elements(v_clubs) e where (e->>'delta')::bigint<0 and (e->>'available')::bigint<-(e->>'delta')::bigint) then raise exception 'Saldo disponível insuficiente para devolver o valor';end if;
 v_before:=jsonb_build_object('clubs',v_clubs,'players',v_players,'agent',v_agent,'snapshot',s.snapshot,'reason',trim(p_reason));v_hash:=md5(v_before::text);
 select jsonb_build_object('clubs',jsonb_agg(jsonb_build_object('id',e->>'id','name',e->>'name','balance',(e->>'balance')::bigint+(e->>'delta')::bigint) order by e->>'id'),'history_preserved',true) into v_after from jsonb_array_elements(v_clubs) e;
 if not coalesce(p_confirm,false) then return jsonb_build_object('success',true,'confirmed',false,'preview_hash',v_hash,'before',v_before,'after',v_after);end if;
 if p_expected_hash is null or p_expected_hash is distinct from v_hash then raise exception 'A operação mudou. Gere uma nova prévia de correção';end if;
 for x in select value from jsonb_array_elements(s.snapshot->'ledger') loop
  insert into public.transactions(club_id,type,amount,description,created_by,transaction_type) values((x->>'club_id')::uuid,'adjustment',-(x->>'amount')::bigint,'Correção auditada WhatsApp '||p_id||' / lançamento '||(x->>'id'),auth.uid(),case when (x->>'amount')::bigint>0 then 'debit' else 'credit' end) returning id into v_tx;v_ids:=array_append(v_ids,v_tx);
 end loop;
 for x in select value from jsonb_array_elements(v_players) loop
  if x->>'return_club_id' is null then update public.players set roster_active=false,deleted_at=clock_timestamp() where id=(x->>'id')::uuid;
  else update public.players set club_id=(x->>'return_club_id')::uuid,market_status='available' where id=(x->>'id')::uuid;end if;
 end loop;
 if r.free_agent_id is not null then update public.free_agents set status='available',acquired_at=null,acquired_by_club_id=null where id=r.free_agent_id;end if;
 if r.negotiation_id is not null then update public.admin_market_worksheet set voided_at=clock_timestamp(),voided_by=auth.uid(),void_reason='Correção auditada: '||trim(p_reason) where negotiation_id=r.negotiation_id and voided_at is null;end if;
 insert into public.whatsapp_market_corrections(request_id,inbox_id,reason,before_state,after_state,compensation_ids,corrected_by) values(p_request_id,p_id,trim(p_reason),v_before,v_after,v_ids,auth.uid()) returning * into c;
 insert into public.audit_logs(actor_id,action,target,details,before_value,after_value) values(auth.uid(),'whatsapp_market_settlement_corrected',p_id::text,jsonb_build_object('correction_id',c.id,'reason',trim(p_reason),'compensation_ids',v_ids),v_before,v_after);
 insert into public.notifications(user_id,category,title,body) select a.user_id,'market','Liquidação corrigida','Uma liquidação foi corrigida com saldos e elencos compensados. Motivo: '||trim(p_reason) from public.admin_users a;
 perform private.queue_whatsapp_market_reaction(p_id,'❌');
 return jsonb_build_object('success',true,'confirmed',true,'duplicate',false,'correction_id',c.id,'before',v_before,'after',v_after);
end$$;

revoke all on function private.protect_whatsapp_market_evidence(),private.capture_whatsapp_market_settlement(),private.whatsapp_market_source_corrected(text,uuid) from public,anon,authenticated;
revoke all on function public.admin_preview_whatsapp_market_approval(uuid,integer),public.admin_approve_whatsapp_market_with_preview(uuid,integer,text,boolean,boolean,text),public.admin_correct_whatsapp_market_settlement(uuid,uuid,text,boolean,text) from public,anon;
grant execute on function public.admin_preview_whatsapp_market_approval(uuid,integer),public.admin_approve_whatsapp_market_with_preview(uuid,integer,text,boolean,boolean,text),public.admin_correct_whatsapp_market_settlement(uuid,uuid,text,boolean,text) to authenticated;
