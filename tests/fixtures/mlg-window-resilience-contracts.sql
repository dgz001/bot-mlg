CREATE OR REPLACE FUNCTION public.admin_approve_whatsapp_market_proposal(p_id uuid, p_expected_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.whatsapp_market_inbox%rowtype;n public.negotiations%rowtype;begin
 if auth.uid() is null or not coalesce(public.is_admin(),false) then raise exception 'Somente ADMs podem concluir propostas';end if;perform private.require_admin_aal2_if_enrolled();
 select * into r from public.whatsapp_market_inbox where id=p_id for update;
 if not found then raise exception 'Proposta não encontrada';end if;
 if r.status='settled' then return jsonb_build_object('success',true,'duplicate',true,'negotiation_id',r.negotiation_id);end if;
 if to_jsonb(r)->>'transfer_id' is not null then return private.approve_whatsapp_external_proposal(p_id,p_expected_revision);end if;
 if r.revision is distinct from p_expected_revision or r.status<>'awaiting_signatures' or r.negotiation_id is null then raise exception 'Revise a proposta e seu contrato antes de aprovar';end if;
 select * into n from public.negotiations where id=r.negotiation_id for update;
 if n.status not in('open','accepted') or n.market_cycle_id is distinct from r.market_cycle_id or n.type is distinct from r.kind or n.club_a_id is distinct from r.to_club_id or n.club_b_id is distinct from r.from_club_id or n.player_ids_a is distinct from to_jsonb(r.player_ids_to) or n.player_ids_b is distinct from to_jsonb(r.player_ids_from) or n.cash_from_a is distinct from r.amount or n.cash_from_b<>0 then raise exception 'O contrato não corresponde à proposta atual';end if;
 if not private.market_contract_is_signed('negotiation',n.id) then raise exception 'Aguardando as assinaturas válidas dos dois técnicos nos termos atuais';end if;
 perform 1 from public.clubs where id in(r.from_club_id,r.to_club_id) order by id for update;
 perform 1 from public.players where id=any(r.player_ids_from||r.player_ids_to) order by id for update;
 if (select count(*) from public.players where id=any(r.player_ids_from) and club_id=r.from_club_id and roster_active and market_status='available')<>cardinality(r.player_ids_from) or (select count(*) from public.players where id=any(r.player_ids_to) and club_id=r.to_club_id and roster_active and market_status='available')<>cardinality(r.player_ids_to) then raise exception 'Jogador mudou de clube ou não está disponível';end if;
 if exists(select 1 from public.whatsapp_market_responses x where x.inbox_id=r.id and x.proposal_revision=r.revision and x.identity_verified and x.decision='negative' and not exists(select 1 from public.whatsapp_market_responses newer where newer.inbox_id=x.inbox_id and (newer.participant_id=x.participant_id or exists(select 1 from public.whatsapp_market_actor_links old_alias join public.whatsapp_market_actor_links new_alias on new_alias.user_id=old_alias.user_id where old_alias.participant_id=x.participant_id and new_alias.participant_id=newer.participant_id)) and newer.identity_verified and newer.created_at>x.created_at and newer.proposal_revision=x.proposal_revision)) then raise exception 'Um técnico recusou esta versão. Resolva a recusa antes de concluir';end if;
 if n.status='open' then update public.negotiations set status='accepted',last_action_by=auth.uid(),updated_at=clock_timestamp() where id=n.id;end if;
 perform private.link_whatsapp_market_worksheet(r,n);
 perform public.execute_negotiation(n.id);
 update public.whatsapp_market_inbox set status='settled',settled_at=clock_timestamp(),reviewed_by=auth.uid(),revision=revision+1,updated_at=clock_timestamp() where id=r.id;
 insert into public.audit_logs(actor_id,action,target,details) values(auth.uid(),'whatsapp_market_proposal_settled',r.id::text,jsonb_build_object('negotiation_id',n.id,'message_id',r.message_id,'financial_effect',true,'roster_effect',true));
 perform private.queue_whatsapp_market_reaction(r.id,'🟢');
 return jsonb_build_object('success',true,'negotiation_id',n.id,'financial_effect',true,'roster_effect',true);end$function$;

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
  perform private.queue_whatsapp_market_reaction(r.id,case when r.status='rejected' then '🔴' else '🟠' end);
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
 end if;raise exception 'Ação da captura inválida';end$function$;

CREATE OR REPLACE FUNCTION private.club_financial_commitment(p_club_id uuid, p_exclude_negotiation_id uuid DEFAULT NULL::uuid, p_exclude_auction_id uuid DEFAULT NULL::uuid, p_exclude_loan_id uuid DEFAULT NULL::uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select greatest(0, coalesce((
    select sum(case
      when n.club_a_id = p_club_id then greatest(n.cash_from_a - n.cash_from_b, 0)
      when n.club_b_id = p_club_id then greatest(n.cash_from_b - n.cash_from_a, 0)
      else 0
    end)
    from public.negotiations n
    where p_club_id in (n.club_a_id, n.club_b_id)
      and n.market_cycle_id=(select market_cycle_id from public.market_windows order by updated_at desc nulls last limit 1)
      and n.status in ('open', 'waiting', 'accepted')
      and n.id is distinct from p_exclude_negotiation_id
  ), 0) + coalesce((
    select sum(a.current_bid)
    from public.auctions a
    where a.current_bidder_club_id = p_club_id
      and a.status = 'open'
      and (a.closes_at is null or a.closes_at > now())
      and a.id is distinct from p_exclude_auction_id
  ), 0) + coalesce((
    select sum(case when l.borrower_club_id=p_club_id and l.loaned_player_id is not null then l.fixed_fee when l.lender_club_id=p_club_id and l.status='proposed' then l.cash_principal else 0 end)
    from public.club_loan_contracts l
    where p_club_id in (l.lender_club_id,l.borrower_club_id)
      and l.market_cycle_id=(select market_cycle_id from public.market_windows order by updated_at desc nulls last limit 1)
      and l.status in ('proposed','pending_admin')
      and l.id is distinct from p_exclude_loan_id
  ), 0) + coalesce((select sum(t.price) from public.transfers t where t.to_club_id=p_club_id and t.market_cycle_id=(select market_cycle_id from public.market_windows order by updated_at desc nulls last limit 1) and t.status='pending' and t.source_negotiation_id is null and t.deleted_at is null),0))::bigint;
$function$;

CREATE OR REPLACE FUNCTION public.execute_negotiation(p_negotiation_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := auth.uid();
  v_negotiation public.negotiations%rowtype;
  v_club_a public.clubs%rowtype;
  v_club_b public.clubs%rowtype;
  v_net_cash bigint;
  v_count integer;
  v_names_a jsonb;
  v_names_b jsonb;
begin
  if v_actor is null or not public.is_admin() then
    raise exception 'Apenas administradores podem executar negociações';
  end if;

  select *
    into v_negotiation
  from public.negotiations
  where id = p_negotiation_id
  for update;

  if not found then
    raise exception 'Negociação não encontrada';
  end if;
  if v_negotiation.status = 'executed' then
    return;
  end if;
  if v_negotiation.status <> 'accepted' then
    raise exception 'A negociação precisa estar aceita antes da execução';
  end if;

  perform 1
  from public.clubs c
  where c.id in (v_negotiation.club_a_id, v_negotiation.club_b_id)
  order by c.id
  for update;

  select * into v_club_a
  from public.clubs
  where id = v_negotiation.club_a_id and deleted_at is null;
  if not found then raise exception 'Clube A não encontrado'; end if;

  select * into v_club_b
  from public.clubs
  where id = v_negotiation.club_b_id and deleted_at is null;
  if not found then raise exception 'Clube B não encontrado'; end if;

  perform 1
  from public.players p
  where p.id in (
    select value::uuid from jsonb_array_elements_text(v_negotiation.player_ids_a)
    union
    select value::uuid from jsonb_array_elements_text(v_negotiation.player_ids_b)
  )
  order by p.id
  for update;

  select count(*)
    into v_count
  from public.players p
  where p.club_id = v_negotiation.club_a_id
    and p.id in (
      select value::uuid from jsonb_array_elements_text(v_negotiation.player_ids_a)
    );
  if v_count <> jsonb_array_length(v_negotiation.player_ids_a) then
    raise exception 'Execução interrompida: jogador do clube A mudou de plantel';
  end if;

  select count(*)
    into v_count
  from public.players p
  where p.club_id = v_negotiation.club_b_id
    and p.id in (
      select value::uuid from jsonb_array_elements_text(v_negotiation.player_ids_b)
    );
  if v_count <> jsonb_array_length(v_negotiation.player_ids_b) then
    raise exception 'Execução interrompida: jogador do clube B mudou de plantel';
  end if;

  v_net_cash := v_negotiation.cash_from_a - v_negotiation.cash_from_b;
  if v_net_cash > 0 and v_club_a.balance < v_net_cash then
    raise exception 'Clube A sem saldo suficiente';
  end if;
  if v_net_cash < 0 and v_club_b.balance < abs(v_net_cash) then
    raise exception 'Clube B sem saldo suficiente';
  end if;

  select coalesce(jsonb_agg(p.name order by p.id), '[]'::jsonb)
    into v_names_a
  from public.players p
  where p.id in (
    select value::uuid from jsonb_array_elements_text(v_negotiation.player_ids_a)
  );

  select coalesce(jsonb_agg(p.name order by p.id), '[]'::jsonb)
    into v_names_b
  from public.players p
  where p.id in (
    select value::uuid from jsonb_array_elements_text(v_negotiation.player_ids_b)
  );

  insert into public.transfers(
    source_negotiation_id,
    from_club_id,
    to_club_id,
    player_name,
    player_position,
    player_week_rating,
    price,
    requested_by,
    status,
    reviewed_by,
    reviewed_at,
    player_id,
    offer_status
  )
  select
    v_negotiation.id,
    v_negotiation.club_a_id,
    v_negotiation.club_b_id,
    p.name,
    p.position,
    p.week_rating,
    0,
    coalesce(v_negotiation.initiated_by, v_actor),
    'approved',
    v_actor,
    now(),
    p.id,
    'completed'
  from public.players p
  where p.id in (
    select value::uuid from jsonb_array_elements_text(v_negotiation.player_ids_a)
  );

  insert into public.transfers(
    source_negotiation_id,
    from_club_id,
    to_club_id,
    player_name,
    player_position,
    player_week_rating,
    price,
    requested_by,
    status,
    reviewed_by,
    reviewed_at,
    player_id,
    offer_status
  )
  select
    v_negotiation.id,
    v_negotiation.club_b_id,
    v_negotiation.club_a_id,
    p.name,
    p.position,
    p.week_rating,
    case when v_negotiation.type = 'transfer' then v_negotiation.cash_from_a else 0 end,
    coalesce(v_negotiation.initiated_by, v_actor),
    'approved',
    v_actor,
    now(),
    p.id,
    'completed'
  from public.players p
  where p.id in (
    select value::uuid from jsonb_array_elements_text(v_negotiation.player_ids_b)
  );

  if v_negotiation.type = 'trade' then
    insert into public.trades(
      source_negotiation_id,
      club_a_id,
      club_b_id,
      players_a,
      players_b,
      requested_by,
      status,
      reviewed_by,
      reviewed_at,
      offer_status
    )
    values (
      v_negotiation.id,
      v_negotiation.club_a_id,
      v_negotiation.club_b_id,
      v_names_a,
      v_names_b,
      coalesce(v_negotiation.initiated_by, v_actor),
      'approved',
      v_actor,
      now(),
      'completed'
    );
  end if;

  update public.players
  set club_id = v_negotiation.club_b_id, market_status = 'available'
  where club_id = v_negotiation.club_a_id
    and id in (
      select value::uuid from jsonb_array_elements_text(v_negotiation.player_ids_a)
    );

  update public.players
  set club_id = v_negotiation.club_a_id, market_status = 'available'
  where club_id = v_negotiation.club_b_id
    and id in (
      select value::uuid from jsonb_array_elements_text(v_negotiation.player_ids_b)
    );

  if v_net_cash <> 0 then
    if v_net_cash > 0 then
      insert into public.transactions(
        club_id, type, amount, description, created_by, balance_after, transaction_type
      )
      values
        (
          v_club_a.id,
          'negotiation_payment',
          -v_net_cash,
          'Pagamento da negociação ' || p_negotiation_id::text,
          v_actor,
          v_club_a.balance - v_net_cash,
          'debit'
        ),
        (
          v_club_b.id,
          'negotiation_receipt',
          v_net_cash,
          'Recebimento da negociação ' || p_negotiation_id::text,
          v_actor,
          v_club_b.balance + v_net_cash,
          'credit'
        );
    else
      insert into public.transactions(
        club_id, type, amount, description, created_by, balance_after, transaction_type
      )
      values
        (
          v_club_b.id,
          'negotiation_payment',
          -abs(v_net_cash),
          'Pagamento da negociação ' || p_negotiation_id::text,
          v_actor,
          v_club_b.balance - abs(v_net_cash),
          'debit'
        ),
        (
          v_club_a.id,
          'negotiation_receipt',
          abs(v_net_cash),
          'Recebimento da negociação ' || p_negotiation_id::text,
          v_actor,
          v_club_a.balance + abs(v_net_cash),
          'credit'
        );
    end if;
  end if;

  update public.negotiations
  set
    status = 'executed',
    updated_at = now(),
    closed_at = now(),
    closed_by = v_actor
  where id = p_negotiation_id;

  update public.negotiations
  set status = 'cancelled', closed_at = now(), updated_at = now(), closed_by = v_actor
  where target_player_id = v_negotiation.target_player_id
    and status = 'waiting'
    and id <> p_negotiation_id;

  insert into public.audit_logs(actor_id, action, target, details, before_value, after_value)
  values (
    v_actor,
    'execute_negotiation',
    'negotiations:' || p_negotiation_id::text,
    jsonb_build_object(
      'type', v_negotiation.type,
      'players_a', v_negotiation.player_ids_a,
      'players_b', v_negotiation.player_ids_b,
      'net_cash', v_net_cash,
      'result', 'success',
      'reversible', true
    ),
    jsonb_build_object('club_a_balance', v_club_a.balance, 'club_b_balance', v_club_b.balance),
    jsonb_build_object(
      'club_a_balance', v_club_a.balance - v_net_cash,
      'club_b_balance', v_club_b.balance + v_net_cash,
      'status', 'executed'
    )
  );

  insert into public.notifications(user_id, category, title, body)
  select
    c.coach_user_id,
    'transfer',
    'Negociação concluída',
    'A negociação entre ' || v_club_a.name || ' e ' || v_club_b.name || ' foi concluída.'
  from public.clubs c
  where c.id in (v_club_a.id, v_club_b.id)
    and c.coach_user_id is not null;
end;
$function$;
