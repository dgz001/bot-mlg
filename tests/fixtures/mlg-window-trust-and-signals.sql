-- ADM decisions, per club and per window. No balance or roster changes here.
alter table public.market_balance_penalties drop constraint market_balance_penalties_penalty_check;
alter table public.market_balance_penalties add constraint market_balance_penalties_penalty_check check(penalty in('pending_review','all_market','one_purchase','lifted','expired'));
alter table public.market_balance_penalties alter column penalty set default 'pending_review';
create or replace function private.record_market_overdraft() returns trigger language plpgsql security definer set search_path='' as $$
declare v_cycle uuid;v_id uuid;v_name text;
begin
 if new.balance_after>=0 or new.amount>=0 or new.type not in('negotiation_payment','external_transfer_purchase') then return new;end if;
 select market_cycle_id into v_cycle from public.market_windows order by updated_at desc nulls last limit 1;
 if v_cycle is null then raise exception 'Ciclo obrigatório para registrar saldo negativo';end if;
 insert into public.market_balance_penalties(club_id,market_cycle_id,transaction_id,balance_at_breach,penalty,reason)
 values(new.club_id,v_cycle,new.id,new.balance_after,'pending_review','Saldo negativo registrado. Transfer Ban depende da decisão dos ADMs.') on conflict(club_id,market_cycle_id) do nothing returning id into v_id;
 if v_id is null then return new;end if;
 select name into v_name from public.clubs where id=new.club_id;
 insert into public.audit_logs(actor_id,action,target,details) values(auth.uid(),'market_balance_breach_recorded',v_id::text,jsonb_build_object('club_id',new.club_id,'market_cycle_id',v_cycle,'transaction_id',new.id,'balance',new.balance_after,'penalty','pending_review'));
 insert into public.notifications(user_id,category,title,body) select user_id,'transfer','Saldo negativo para revisão dos ADMs',v_name||': saldo '||new.balance_after||'. Ocorrência registrada sem bloqueio automático. Os ADMs decidem sobre o Transfer Ban.' from public.admin_users;
 return new;
end $$;
create table public.market_window_club_options(
 club_id uuid not null references public.clubs(id),market_cycle_id uuid not null,
 trust_trade boolean not null default false,purchase_exception_limit integer check(purchase_exception_limit between 1 and 100),
 reason text not null check(length(trim(reason)) between 5 and 500),updated_by uuid not null references auth.users(id),updated_at timestamptz not null default now(),
 primary key(club_id,market_cycle_id)
);
alter table public.market_window_club_options enable row level security;
revoke all on public.market_window_club_options from public,anon,authenticated;
grant select on public.market_window_club_options to authenticated;
create policy market_window_options_read on public.market_window_club_options for select to authenticated using(public.is_admin() or exists(select 1 from public.coach_profiles cp where cp.user_id=auth.uid() and cp.club_id=market_window_club_options.club_id and cp.status='active' and cp.deleted_at is null));
alter table public.whatsapp_market_inbox add column quota_flags jsonb not null default '[]'::jsonb check(jsonb_typeof(quota_flags)='array');

create function private.market_effective_limits(p_club uuid,p_cycle uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('purchase_limit',greatest(w.max_transfers_per_club+case when coalesce(o.trust_trade,false) then 1 else 0 end,coalesce(o.purchase_exception_limit,0)),
 'sale_limit',w.max_sales_per_club,'trade_limit',greatest(w.max_trades_per_club-case when coalesce(o.trust_trade,false) then 1 else 0 end,0),'trust_trade',coalesce(o.trust_trade,false))
 from public.market_windows w left join public.market_window_club_options o on o.club_id=p_club and o.market_cycle_id=w.market_cycle_id where w.market_cycle_id=p_cycle order by w.updated_at desc nulls last limit 1;
$$;
revoke all on function private.market_effective_limits(uuid,uuid) from public,anon,authenticated;

create function public.admin_set_market_club_option(p_club_id uuid,p_trust_trade boolean,p_exception_limit integer,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.market_windows%rowtype;u jsonb;v_trade integer;v_purchase integer;v_before jsonb;
begin
 if auth.uid() is null or not coalesce(public.is_admin(),false) then raise exception 'Somente ADMs podem autorizar limites';end if;
 perform private.require_admin_aal2_if_enrolled();
 if p_trust_trade is null or length(trim(coalesce(p_reason,''))) not between 5 and 500 then raise exception 'Confirme a opção e descreva o motivo';end if;
 select * into w from public.market_windows order by updated_at desc nulls last limit 1 for share;
 if not found then raise exception 'Janela não configurada';end if;
 perform 1 from public.clubs where id=p_club_id and deleted_at is null for update;if not found then raise exception 'Clube não encontrado';end if;
 if p_exception_limit is not null and (p_exception_limit<w.max_transfers_per_club or p_exception_limit>100) then raise exception 'Limite excepcional inválido';end if;
 v_trade:=w.max_trades_per_club-case when p_trust_trade then 1 else 0 end;
 v_purchase:=greatest(w.max_transfers_per_club+case when p_trust_trade then 1 else 0 end,coalesce(p_exception_limit,0));
 u:=private.market_window_usage(p_club_id,w.market_cycle_id);
 if v_trade<0 or (u->>'trades')::int>v_trade or (u->>'purchases')::int>v_purchase then raise exception 'A opção conflita com operações concluídas ou reservadas; revise antes de reduzir os limites';end if;
 select to_jsonb(o) into v_before from public.market_window_club_options o where club_id=p_club_id and market_cycle_id=w.market_cycle_id;
 insert into public.market_window_club_options(club_id,market_cycle_id,trust_trade,purchase_exception_limit,reason,updated_by)
 values(p_club_id,w.market_cycle_id,p_trust_trade,p_exception_limit,trim(p_reason),auth.uid()) on conflict(club_id,market_cycle_id) do update set trust_trade=excluded.trust_trade,purchase_exception_limit=excluded.purchase_exception_limit,reason=excluded.reason,updated_by=excluded.updated_by,updated_at=now();
 insert into public.audit_logs(actor_id,action,target,before_value,after_value,details) values(auth.uid(),'market_club_option_authorized',p_club_id::text,v_before,private.market_effective_limits(p_club_id,w.market_cycle_id),jsonb_build_object('cycle',w.market_cycle_id,'reason',trim(p_reason)));
 return jsonb_build_object('success',true,'limits',private.market_effective_limits(p_club_id,w.market_cycle_id),'financial_effect',false);
end $$;
revoke all on function public.admin_set_market_club_option(uuid,boolean,integer,text) from public,anon;
grant execute on function public.admin_set_market_club_option(uuid,boolean,integer,text) to authenticated;

-- Only concluded operations count as completed. Pending reservations continue
-- to be checked independently by the existing transactional quota guard.
create function private.market_window_completed_usage(p_club_id uuid,p_cycle_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
select jsonb_build_object(
 'purchases',coalesce((select sum(jsonb_array_length(n.player_ids_b)) from public.negotiations n where n.club_a_id=p_club_id and n.type='transfer' and n.market_cycle_id=p_cycle_id and n.status='executed' and not private.whatsapp_market_source_corrected('negotiation',n.id)),0)+(select count(*) from public.transfers t where t.to_club_id=p_club_id and t.market_cycle_id=p_cycle_id and t.source_negotiation_id is null and t.status='approved' and t.deleted_at is null and not private.whatsapp_market_source_corrected('transfer',t.id)),
 'sales',coalesce((select sum(jsonb_array_length(n.player_ids_b)) from public.negotiations n where n.club_b_id=p_club_id and n.type='transfer' and n.market_cycle_id=p_cycle_id and n.status='executed' and not private.whatsapp_market_source_corrected('negotiation',n.id)),0)+(select count(*) from public.transfers t where t.from_club_id=p_club_id and t.market_cycle_id=p_cycle_id and t.source_negotiation_id is null and t.status='approved' and t.deleted_at is null and not private.whatsapp_market_source_corrected('transfer',t.id)),
 'trades',(select count(*) from public.negotiations n where p_club_id in(n.club_a_id,n.club_b_id) and n.type='trade' and n.market_cycle_id=p_cycle_id and n.status='executed' and not private.whatsapp_market_source_corrected('negotiation',n.id)));
$$;
revoke all on function private.market_window_completed_usage(uuid,uuid) from public,anon,authenticated;

create function private.signal_whatsapp_market_quota() returns trigger language plpgsql security definer set search_path='' as $$
declare w public.market_windows%rowtype;v_buyer uuid;v_seller uuid;u jsonb;v_names text[];v_count integer;v_actor jsonb;v_name text;v_coach text;v_flags jsonb:='[]';v_summary text;
begin
 new.quota_flags:='[]';if new.kind<>'transfer' then return new;end if;
 select * into w from public.market_windows order by updated_at desc nulls last limit 1;
 if not found or (new.market_cycle_id is not null and new.market_cycle_id<>w.market_cycle_id) then return new;end if;
 v_actor:=new.parsed->'officialActor';
 v_buyer:=nullif(v_actor->>'club_id','')::uuid;
 if v_buyer is not null and exists(select 1 from public.clubs where id=v_buyer and deleted_at is null and private.market_name_key(name)=private.market_name_key(new.parsed->>'destination')) then
  u:=private.market_window_completed_usage(v_buyer,w.market_cycle_id);
  if (u->>'purchases')::int>=w.max_transfers_per_club then
   select name into v_name from public.clubs where id=v_buyer;
   v_flags:=v_flags||jsonb_build_array(jsonb_build_object('type','purchase','club_id',v_buyer,'club',v_name,'coach',coalesce(v_actor->>'coach','Responsável oficial'),'used',(u->>'purchases')::int,'limit',w.max_transfers_per_club,'decision','admin_review'));
  end if;
 end if;
 if new.purchase_scope='internal' and jsonb_array_length(coalesce(new.parsed->'issues','[]'))=0 then
  select array_agg(private.market_name_key(value)) into v_names from jsonb_array_elements_text(coalesce(new.parsed->'playersFrom','[]'));
  select count(*),(array_agg(c.id))[1] into v_count,v_seller from public.players p join public.clubs c on c.id=p.club_id where p.roster_active and c.deleted_at is null and private.market_name_key(c.name)=private.market_name_key(new.parsed->>'origin') and private.market_name_key(p.name)=any(v_names);
  if v_count=1 and cardinality(v_names)=1 then
   u:=private.market_window_completed_usage(v_seller,w.market_cycle_id);
   if (u->>'sales')::int>=w.max_sales_per_club then
    select c.name,d.coach_name into v_name,v_coach from public.clubs c left join public.whatsapp_market_club_directory d on d.club_id=c.id where c.id=v_seller;
    v_flags:=v_flags||jsonb_build_array(jsonb_build_object('type','sale','club_id',v_seller,'club',v_name,'coach',coalesce(v_coach,'Responsável oficial'),'used',(u->>'sales')::int,'limit',w.max_sales_per_club,'decision','automatic_rejection'));
    new.status:='rejected';new.automatic_rejection:=true;
   end if;
  end if;
 end if;
 new.quota_flags:=v_flags;
 if jsonb_array_length(v_flags)>0 then
  select string_agg((f->>'coach')||' · '||(f->>'club')||': '||case f->>'type' when 'purchase' then 'compras' else 'vendas' end||' '||(f->>'used')||'/'||(f->>'limit')||'; proposta excedente precisa de conferência.', ' ') into v_summary from jsonb_array_elements(v_flags) f;
  new.classification_note:=concat_ws(' ',new.classification_note,v_summary);
  if new.automatic_rejection then new.review_note:=new.classification_note;else new.status:='needs_review';end if;
 end if;
 return new;
end $$;
revoke all on function private.signal_whatsapp_market_quota() from public,anon,authenticated;
create trigger whatsapp_market_quota_signal before insert or update of parsed,kind on public.whatsapp_market_inbox for each row execute function private.signal_whatsapp_market_quota();

create function private.notify_whatsapp_market_quota() returns trigger language plpgsql security definer set search_path='' as $$
declare v_body text;f jsonb;v_recipient text;
begin
 if jsonb_array_length(new.quota_flags)=0 and not new.automatic_rejection then return new;end if;
 v_body:='Olá! A proposta MLG-'||left(new.id::text,8)||' foi sinalizada para conferência. '||coalesce(new.classification_note,'Possível irregularidade identificada.')||' Nenhum saldo foi alterado. Compras excedentes dependem da decisão dos ADMs; consulte a administração em caso de dúvida.';
 insert into private.whatsapp_market_private_notices(inbox_id,recipient,body) select new.id,new.participant_id,v_body where new.participant_id~'^[0-9]+@(s[.]whatsapp[.]net|lid)$' on conflict(inbox_id,recipient) do nothing;
 for f in select value from jsonb_array_elements(new.quota_flags) loop
  select phone||'@s.whatsapp.net' into v_recipient from public.whatsapp_market_club_directory where club_id=(f->>'club_id')::uuid;
  if v_recipient~'^[0-9]+@s[.]whatsapp[.]net$' then insert into private.whatsapp_market_private_notices(inbox_id,recipient,body) values(new.id,v_recipient,v_body) on conflict(inbox_id,recipient) do nothing;end if;
 end loop;
 perform private.queue_whatsapp_market_reaction(new.id,'❌');return new;
end $$;
revoke all on function private.notify_whatsapp_market_quota() from public,anon,authenticated;
create trigger whatsapp_market_quota_notice after insert or update of parsed,kind on public.whatsapp_market_inbox for each row execute function private.notify_whatsapp_market_quota();
CREATE OR REPLACE FUNCTION private.guard_market_window_quota()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_w public.market_windows%rowtype; v_a jsonb; v_b jsonb; v_c uuid;
begin
 select * into v_w from public.market_windows order by updated_at desc nulls last limit 1;
 if tg_table_name='club_loan_contracts' then
   if tg_op='INSERT' then
     if not v_w.loan_window_open then raise exception 'Empréstimos desativados nesta janela pelos DMs'; end if;
     new.market_cycle_id:=v_w.market_cycle_id;
   end if;
   return new;
 end if;
 if tg_table_name='negotiations' then
   if new.status not in ('open','waiting','accepted','executed') then return new; end if;
   if tg_op='UPDATE' and old.status='executed' then return new; end if;
   perform 1 from public.clubs where id in (new.club_a_id,new.club_b_id) order by id for update;
   if new.market_cycle_id is distinct from v_w.market_cycle_id then raise exception 'Esta proposta pertence a outra janela; crie uma nova proposta'; end if;
   if v_w.maintenance_mode or v_w.read_only_mode or (new.type='transfer' and not v_w.transfer_window_open) or (new.type='trade' and not v_w.trade_window_open) then raise exception 'A janela desta operação está fechada'; end if;
   if not exists(select 1 from public.market_module_policies where module=new.type and enabled and member_actions_enabled) then raise exception 'Operação pausada pelos DMs'; end if;
   if new.type='trade' and not coalesce((select (rules->>'allow_cash')::boolean from public.market_module_policies where module='trade'),false) and (new.cash_from_a<>0 or new.cash_from_b<>0) then raise exception 'Trocas desta janela não podem envolver dinheiro'; end if;
   if new.status<>'executed' and ((select count(*) from public.players where club_id=new.club_a_id and roster_active and new.player_ids_a ? id::text)<>jsonb_array_length(new.player_ids_a) or (select count(*) from public.players where club_id=new.club_b_id and roster_active and new.player_ids_b ? id::text)<>jsonb_array_length(new.player_ids_b)) then raise exception 'Jogador indisponível no elenco ativo'; end if;
   if new.status='executed' and ((select count(*) from public.players where club_id=new.club_b_id and new.player_ids_a ? id::text)<>jsonb_array_length(new.player_ids_a) or (select count(*) from public.players where club_id=new.club_a_id and new.player_ids_b ? id::text)<>jsonb_array_length(new.player_ids_b)) then raise exception 'Execução não registrou os jogadores nos destinos assinados'; end if;
   v_a:=private.market_window_usage(new.club_a_id,v_w.market_cycle_id,new.id);
   v_b:=private.market_window_usage(new.club_b_id,v_w.market_cycle_id,new.id);
   if new.type='transfer' then
     if jsonb_array_length(new.player_ids_a)<>0 or jsonb_array_length(new.player_ids_b)<>1 or new.cash_from_a<=0 or new.cash_from_b<>0 then raise exception 'Compra exige um jogador do vendedor e valor positivo'; end if;
     if (v_a->>'purchases')::int+1>(private.market_effective_limits(new.club_a_id,v_w.market_cycle_id)->>'purchase_limit')::int then raise exception 'Limite de compras atingido ou reservado nesta janela'; end if;
     if (v_b->>'sales')::int+1>v_w.max_sales_per_club then raise exception 'Limite de vendas atingido ou reservado nesta janela'; end if;
   elsif new.type='trade' then
     if jsonb_array_length(new.player_ids_a)=0 or jsonb_array_length(new.player_ids_b)=0 then raise exception 'Troca exige jogadores dos dois clubes'; end if;
     if (v_a->>'trades')::int+1>(private.market_effective_limits(new.club_a_id,v_w.market_cycle_id)->>'trade_limit')::int or (v_b->>'trades')::int+1>(private.market_effective_limits(new.club_b_id,v_w.market_cycle_id)->>'trade_limit')::int then raise exception 'Limite de trocas atingido ou reservado nesta janela'; end if;
   end if;
 elsif tg_table_name='transfers' then
   if new.source_negotiation_id is not null then
     if not exists(select 1 from public.negotiations n where n.id=new.source_negotiation_id and n.status='accepted' and ((new.from_club_id=n.club_a_id and new.to_club_id=n.club_b_id and n.player_ids_a ? new.player_id::text) or (new.from_club_id=n.club_b_id and new.to_club_id=n.club_a_id and n.player_ids_b ? new.player_id::text))) then raise exception 'Transferência não corresponde à negociação aceita'; end if;
     return new;
   end if;
   if new.status not in ('pending','approved') then return new; end if;
   if tg_op='UPDATE' and old.status='approved' then return new; end if;
   perform 1 from public.clubs where id in (new.from_club_id,new.to_club_id) order by id for update;
   if not v_w.transfer_window_open or v_w.maintenance_mode or v_w.read_only_mode then raise exception 'Janela de transferências fechada'; end if;
   if new.market_cycle_id is distinct from v_w.market_cycle_id then raise exception 'Solicitação de outra janela'; end if;
   v_a:=private.market_window_usage(new.to_club_id,v_w.market_cycle_id,null,new.id);
   if (v_a->>'purchases')::int+1>(private.market_effective_limits(new.to_club_id,v_w.market_cycle_id)->>'purchase_limit')::int then raise exception 'Limite de compras atingido ou reservado nesta janela'; end if;
   if new.from_club_id is not null then
     v_b:=private.market_window_usage(new.from_club_id,v_w.market_cycle_id,null,new.id);
     if (v_b->>'sales')::int+1>v_w.max_sales_per_club then raise exception 'Limite de vendas atingido ou reservado nesta janela'; end if;
   end if;
 end if;
 return new;
end $function$


CREATE OR REPLACE FUNCTION public.get_my_market_window_usage()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_club uuid; v_w public.market_windows%rowtype;
begin
 if auth.uid() is null then raise exception 'Autenticação obrigatória'; end if;
 select club_id into v_club from public.coach_profiles where user_id=auth.uid() and status='active' and deleted_at is null limit 1;
 if v_club is null then raise exception 'Clube ativo obrigatório'; end if;
 select * into v_w from public.market_windows order by updated_at desc nulls last limit 1;
 return private.market_window_usage(v_club,v_w.market_cycle_id)||jsonb_build_object('purchase_limit',(private.market_effective_limits(v_club,v_w.market_cycle_id)->>'purchase_limit')::int,'sale_limit',v_w.max_sales_per_club,'trade_limit',(private.market_effective_limits(v_club,v_w.market_cycle_id)->>'trade_limit')::int,'completed',private.market_window_completed_usage(v_club,v_w.market_cycle_id),'loan_window_open',v_w.loan_window_open,'market_cycle_id',v_w.market_cycle_id);
end $function$


CREATE OR REPLACE FUNCTION public.admin_retract_whatsapp_market_classification(p_id uuid, p_expected_revision integer, p_scope text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.whatsapp_market_inbox%rowtype;
begin
 if auth.uid() is null or not coalesce(public.is_admin(),false) then raise exception 'Somente ADMs podem corrigir a classificação';end if;
 perform private.require_admin_aal2_if_enrolled();
 if p_scope not in('internal','external','review') or length(trim(coalesce(p_reason,''))) not between 5 and 500 then raise exception 'Selecione o tipo e descreva a correção';end if;
 select * into r from public.whatsapp_market_inbox where id=p_id for update;
 if not found or r.revision is distinct from p_expected_revision then raise exception 'A proposta mudou. Atualize antes de corrigir';end if;
 if r.kind<>'transfer' or r.status='settled' or (r.status='rejected' and not r.automatic_rejection) or r.negotiation_id is not null or r.transfer_id is not null then raise exception 'Esta decisão ou contrato não permite retirar a classificação automática';end if;
 update public.whatsapp_market_inbox set purchase_scope=p_scope,automatic_rejection=false,quota_flags='[]'::jsonb,status='needs_review',classification_note='Classificação corrigida pelo ADM: '||trim(p_reason),review_note=trim(p_reason),reviewed_by=auth.uid(),revision=revision+1,updated_at=clock_timestamp() where id=p_id;
 insert into public.audit_logs(actor_id,action,target,details) values(auth.uid(),'whatsapp_market_classification_retracted',p_id::text,jsonb_build_object('previous_scope',r.purchase_scope,'scope',p_scope,'reason',trim(p_reason),'automatic_rejection',r.automatic_rejection));
 perform private.queue_whatsapp_market_reaction(p_id,'');
 return jsonb_build_object('success',true,'financial_effect',false,'roster_effect',false);
end $function$


CREATE OR REPLACE FUNCTION public.bot_whatsapp_market_bridge(p_token text, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.whatsapp_market_inbox%rowtype;v_kind text;v_hash text;v_output jsonb;v_lease uuid;v_reaction private.whatsapp_market_reactions%rowtype;begin
 if p_token is null or length(p_token)<>64 or not exists(select 1 from private.whatsapp_market_credentials where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex')) then raise exception 'Credencial da captura inválida' using errcode='42501';end if;
 if pg_column_size(p_payload)>50000 then raise exception 'Mensagem maior que o permitido';end if;
 if p_action='config' then return jsonb_build_object('channels',coalesce((select jsonb_agg(jsonb_build_object('kind',kind,'group',group_id)) from public.whatsapp_market_channels),'[]'::jsonb));end if;
 if p_action='response' then return private.ingest_whatsapp_market_response(p_payload);end if;
 if p_action='ingest' then
  select kind into v_kind from public.whatsapp_market_channels where group_id=p_payload->>'group';
  if v_kind is null then raise exception 'Grupo não configurado para captura';end if;
  if length(coalesce(p_payload->>'messageId','')) not between 1 and 200 or coalesce(p_payload->>'participant','')!~'^[0-9]+@(s\.whatsapp\.net|lid)$' or length(coalesce(p_payload->>'text','')) not between 1 and 16000 or jsonb_typeof(p_payload->'parsed') is distinct from 'object' then raise exception 'Mensagem inválida';end if;
  if p_payload->'parsed'->>'kind' is distinct from v_kind then raise exception 'Modelo incompatível com o grupo configurado';end if;
  perform pg_advisory_xact_lock(hashtextextended((p_payload->>'group')||':'||(p_payload->>'messageId'),0));
  v_hash:=encode(sha256(convert_to(p_payload->>'text','UTF8')),'hex');
  select * into r from public.whatsapp_market_inbox where group_id=p_payload->>'group' and message_id=p_payload->>'messageId' for update;
  if found then
   if r.participant_id is distinct from p_payload->>'participant' then raise exception 'Identidade da mensagem não corresponde ao registro';end if;
   if r.content_hash=v_hash then return jsonb_build_object('success',true,'id',r.id,'duplicate',true,'status',r.status);end if;
   if r.status in('settled','rejected') then
    insert into public.audit_logs(action,target,details) values('whatsapp_market_final_message_edited',r.id::text,jsonb_build_object('content_hash',v_hash));
    return jsonb_build_object('success',true,'id',r.id,'final_message_edited',true,'status',r.status);
   end if;
   -- An edited source invalidates the associated pending contract and all its old signatures.
   if r.negotiation_id is not null then
    perform 1 from public.negotiations where id=r.negotiation_id for update;
    if exists(select 1 from public.negotiations where id=r.negotiation_id and status='executed') then raise exception 'Contrato já concluído; correção precisa de revisão administrativa';end if;
    update public.negotiations set status='cancelled',updated_at=clock_timestamp(),closed_at=clock_timestamp() where id=r.negotiation_id and status<>'executed';
   end if;
   if to_jsonb(r)->>'transfer_id' is not null then
    perform 1 from public.transfers where id=(to_jsonb(r)->>'transfer_id')::uuid for update;
    if exists(select 1 from public.transfers where id=(to_jsonb(r)->>'transfer_id')::uuid and status='approved') then raise exception 'Contrato externo já concluído';end if;
    update public.transfers set status='rejected',reviewed_at=clock_timestamp() where id=(to_jsonb(r)->>'transfer_id')::uuid and status='pending';
   end if;
   update public.whatsapp_market_inbox set card_reading=p_payload->'cardReading',mentioned_jids=array(select jsonb_array_elements_text(coalesce(p_payload->'mentions','[]'))),raw_text=p_payload->>'text',content_hash=v_hash,parsed=p_payload->'parsed',revision=revision+1,status='needs_review',negotiation_id=null,transfer_id=null,free_agent_id=null,card_week=null,from_club_id=null,to_club_id=null,player_ids_from='{}',player_ids_to='{}',amount=null,reviewed_by=null,review_note='Mensagem editada; revise os termos novamente',updated_at=clock_timestamp() where id=r.id returning * into r;
  else
   insert into public.whatsapp_market_inbox(group_id,message_id,participant_id,raw_text,content_hash,parsed,kind,status,mentioned_jids,card_reading) values(p_payload->>'group',p_payload->>'messageId',p_payload->>'participant',p_payload->>'text',v_hash,p_payload->'parsed',v_kind,case when jsonb_array_length(coalesce(p_payload->'parsed'->'issues','[]'))>0 then 'needs_review' else 'received' end,array(select jsonb_array_elements_text(coalesce(p_payload->'mentions','[]'))),p_payload->'cardReading') returning * into r;
  end if;
  perform private.queue_whatsapp_market_reaction(r.id,case when r.automatic_rejection or jsonb_array_length(r.quota_flags)>0 then '❌' when r.status='rejected' then '🔴' else '🟠' end);
  return jsonb_build_object('success',true,'id',r.id,'status',r.status);
 elsif p_action='claim_reactions' then
  v_lease:=gen_random_uuid();
  with picked as(select inbox_id from private.whatsapp_market_reactions where delivered_at is null and (lease_until is null or lease_until<clock_timestamp()) order by updated_at limit 20 for update skip locked),leased as(update private.whatsapp_market_reactions x set lease_id=v_lease,lease_until=clock_timestamp()+interval '90 seconds' from picked where x.inbox_id=picked.inbox_id returning x.*)
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'revision',x.revision,'emoji',x.emoji,'lease',x.lease_id,'group',i.group_id,'messageId',i.message_id,'participant',i.participant_id)),'[]'::jsonb) into v_output from leased x join public.whatsapp_market_inbox i on i.id=x.inbox_id;
  return jsonb_build_object('reactions',v_output);
 elsif p_action='ack_reaction' then
  select * into v_reaction from private.whatsapp_market_reactions where inbox_id=(p_payload->>'id')::uuid for update;
  if not found or v_reaction.lease_id is distinct from (p_payload->>'lease')::uuid or v_reaction.revision is distinct from (p_payload->>'revision')::integer or v_reaction.emoji is distinct from p_payload->>'emoji' then return jsonb_build_object('success',false,'stale',true);end if;
  update private.whatsapp_market_reactions set delivered_at=case when p_payload->>'sent'='true' then clock_timestamp() else null end,lease_id=null,lease_until=null where inbox_id=v_reaction.inbox_id;
  return jsonb_build_object('success',true);
 end if;raise exception 'Ação da captura inválida';end$function$


CREATE OR REPLACE FUNCTION private.claim_whatsapp_market_admin_notices(p_groups jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_lease uuid:=gen_random_uuid();v_output jsonb;v_bucket timestamptz:=date_trunc('hour',clock_timestamp());r public.whatsapp_market_inbox%rowtype;v_groups text[];v_body text;
begin
 if jsonb_typeof(p_groups) is distinct from 'array' or jsonb_array_length(p_groups)>20 then raise exception 'Grupos administrativos inválidos';end if;
 select array_agg(value) into v_groups from jsonb_array_elements_text(p_groups) where value~'^[0-9-]{5,40}@g[.]us$';
 if coalesce(cardinality(v_groups),0)=0 then return jsonb_build_object('notices','[]'::jsonb);end if;
 perform pg_advisory_xact_lock(hashtextextended('whatsapp-market-reminders',0));
 for r in select * from public.whatsapp_market_inbox where (status not in('settled','rejected') and updated_at<clock_timestamp()-interval '30 minutes') or (automatic_rejection and created_at>clock_timestamp()-interval '1 hour') or (jsonb_array_length(quota_flags)>0 and status not in('settled','rejected')) order by created_at limit 100 loop
  v_body:=case when r.automatic_rejection or jsonb_array_length(r.quota_flags)>0 then '🔎 Rejeição automática para conferir: ' else '⏳ Negociação pendente de conferência: ' end||'MLG-'||left(r.id::text,8)||'. '||case r.purchase_scope when 'internal' then 'Compra entre clubes' when 'external' then 'Compra externa' when 'trade' then 'Troca' else 'Tipo de compra a conferir' end||'. '||coalesce(r.classification_note,'')||' Estado: '||r.status||'. Confira a proposta original na plataforma MLG: https://v0-mlg01.vercel.app/admin?mlg_target=whatsapp-market';
  if not exists(select 1 from private.whatsapp_market_admin_notices where inbox_id=r.id and revision=r.revision and (case when r.automatic_rejection or jsonb_array_length(r.quota_flags)>0 then true else bucket=v_bucket end)) then
   insert into public.notifications(user_id,category,title,body,deep_link)
   select a.user_id,'market','Negociação precisa de atenção',v_body,'/admin?mlg_target=whatsapp-market' from public.admin_users a join auth.users u on u.id=a.user_id where u.deleted_at is null and u.email_confirmed_at is not null and (u.banned_until is null or u.banned_until<=now());
  end if;
  insert into private.whatsapp_market_admin_notices(inbox_id,revision,bucket,group_id,body)
  select r.id,r.revision,case when r.automatic_rejection or jsonb_array_length(r.quota_flags)>0 then date_trunc('hour',r.created_at) else v_bucket end,g,v_body from unnest(v_groups) g on conflict do nothing;
 end loop;
 -- Do not deliver stale reminders after an ADM's decision or correction.
 update private.whatsapp_market_admin_notices n set delivered_at=clock_timestamp() from public.whatsapp_market_inbox i where i.id=n.inbox_id and n.delivered_at is null and (i.revision<>n.revision or (i.status in('settled','rejected') and not i.automatic_rejection));
 with picked as(select id from private.whatsapp_market_admin_notices where delivered_at is null and group_id=any(v_groups) and (lease_until is null or lease_until<clock_timestamp()) order by created_at limit 20 for update skip locked),leased as(update private.whatsapp_market_admin_notices n set lease_id=v_lease,lease_until=clock_timestamp()+interval '90 seconds' from picked where n.id=picked.id returning n.*)
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'lease',lease_id,'group',group_id,'body',body)),'[]'::jsonb) into v_output from leased;
 return jsonb_build_object('notices',v_output);
end $function$

notify pgrst,'reload schema';
create or replace function private.claim_market_balance_penalty_notices(p_groups jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_groups text[];v_lease uuid:=gen_random_uuid();v_output jsonb;v_existing jsonb;
begin
 if jsonb_typeof(p_groups) is distinct from 'array' or jsonb_array_length(p_groups)>20 then raise exception 'Grupos administrativos inválidos';end if;
 select array_agg(value) into v_groups from jsonb_array_elements_text(p_groups) where value~'^[0-9-]{5,40}@g[.]us$';
 v_existing:=private.claim_whatsapp_market_admin_notices(p_groups);
 insert into private.market_balance_penalty_deliveries(penalty_id,revision,group_id,body)
 select p.id,p.revision,g,case when p.penalty='pending_review' then '📋 Saldo para revisão — ' else '🚫 Transfer Ban — ' end||c.name||'. Saldo na ocorrência: €'||p.balance_at_breach||'. '||case p.penalty when 'pending_review' then 'Sem bloqueio automático; os ADMs decidem sobre a sanção.' when 'all_market' then 'Todas as movimentações bloqueadas nesta janela.' when 'one_purchase' then 'Uma compra retirada da quota desta janela.' when 'expired' then 'Penalidade encerrada: janela cumprida.' else 'Penalidade liberada pelos ADMs.' end||' Motivo: '||p.reason||' Confira na plataforma: https://v0-mlg01.vercel.app/admin?mlg_target=whatsapp-market'
 from public.market_balance_penalties p join public.clubs c on c.id=p.club_id cross join unnest(v_groups) g
 on conflict do nothing;
 update private.market_balance_penalty_deliveries d set delivered_at=clock_timestamp() from public.market_balance_penalties p where d.penalty_id=p.id and d.revision<>p.revision and d.delivered_at is null;
 with picked as(select id from private.market_balance_penalty_deliveries where delivered_at is null and group_id=any(v_groups) and (lease_until is null or lease_until<clock_timestamp()) order by created_at limit 10 for update skip locked),
 leased as(update private.market_balance_penalty_deliveries d set lease_id=v_lease,lease_until=clock_timestamp()+interval '90 seconds' from picked where d.id=picked.id returning d.*)
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'lease',lease_id,'group',group_id,'body',body)),'[]') into v_output from leased;
 return jsonb_build_object('notices',coalesce(v_existing->'notices','[]')||v_output);
end $$;
revoke all on function private.claim_market_balance_penalty_notices(jsonb) from public,anon,authenticated;


