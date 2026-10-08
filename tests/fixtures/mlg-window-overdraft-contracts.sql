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
$function$
;

CREATE OR REPLACE FUNCTION public.accept_negotiation(p_negotiation_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_catalog'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_actor_club uuid;
  v_n public.negotiations%rowtype;
  v_count integer;
  v_net_cash bigint;
begin
  if v_actor is null then raise exception 'Autenticação obrigatória'; end if;
  select * into v_n from public.negotiations where id = p_negotiation_id for update;
  if not found then raise exception 'Negociação não encontrada'; end if;
  if v_n.status = 'accepted' then return; end if;
  if v_n.status <> 'open' then raise exception 'Apenas negociações abertas podem ser aceitas'; end if;

  select club_id into v_actor_club from public.coach_profiles
  where user_id = v_actor and status = 'active' and deleted_at is null limit 1;
  if not public.is_admin() and (v_actor_club is null or v_actor_club not in (v_n.club_a_id, v_n.club_b_id)) then
    raise exception 'Sem permissão para esta negociação';
  end if;
  if v_n.last_action_by = v_actor then raise exception 'O outro clube precisa responder aos termos'; end if;

  perform 1 from public.clubs c where c.id in (v_n.club_a_id, v_n.club_b_id) order by c.id for update;
  perform 1 from public.players p where p.id in (
    select value::uuid from jsonb_array_elements_text(v_n.player_ids_a)
    union select value::uuid from jsonb_array_elements_text(v_n.player_ids_b)
  ) order by p.id for update;
  select count(*) into v_count from public.players p where p.club_id = v_n.club_a_id
    and p.id in (select value::uuid from jsonb_array_elements_text(v_n.player_ids_a));
  if v_count <> jsonb_array_length(v_n.player_ids_a) then raise exception 'A oferta mudou: jogador indisponível no clube A'; end if;
  select count(*) into v_count from public.players p where p.club_id = v_n.club_b_id
    and p.id in (select value::uuid from jsonb_array_elements_text(v_n.player_ids_b));
  if v_count <> jsonb_array_length(v_n.player_ids_b) then raise exception 'A oferta mudou: jogador indisponível no clube B'; end if;
  v_net_cash := v_n.cash_from_a - v_n.cash_from_b;

  update public.negotiations set status = 'accepted', last_action_by = v_actor, updated_at = now() where id = v_n.id;
  insert into public.market_negotiation_revisions(
    negotiation_id, revision, actor_id, player_ids_a, player_ids_b, cash_from_a, cash_from_b, action
  ) values (v_n.id, v_n.revision, v_actor, v_n.player_ids_a, v_n.player_ids_b, v_n.cash_from_a, v_n.cash_from_b, 'accepted')
  on conflict do nothing;
  insert into public.audit_logs(actor_id, action, target, details)
  values (v_actor, 'accept_negotiation', 'negotiations:' || v_n.id::text,
    jsonb_build_object('club_id', v_actor_club, 'revision', v_n.revision, 'result', 'accepted'));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_preview_whatsapp_market_approval(p_id uuid, p_expected_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.whatsapp_market_inbox%rowtype;w public.market_windows%rowtype;v_clubs jsonb;v_players jsonb;v_state jsonb;v_actor jsonb;
begin
 if auth.uid() is null or not coalesce(public.is_admin(),false) then raise exception 'Somente ADMs podem conferir propostas';end if;
 perform private.require_market_not_paused();
 select * into r from public.whatsapp_market_inbox where id=p_id;
 if not found or r.status<>'awaiting_signatures' or r.revision is distinct from p_expected_revision then raise exception 'Proposta mudou: atualize a conferência';end if;
 select * into w from public.market_windows order by updated_at desc nulls last limit 1;
 if not found or r.market_cycle_id is distinct from w.market_cycle_id or w.maintenance_mode or w.read_only_mode or (r.kind='trade' and not w.trade_window_open) or (r.kind='transfer' and not w.transfer_window_open) then raise exception 'A janela desta proposta não está liberada';end if;
 v_actor:=coalesce(private.whatsapp_market_directory_actor(r.participant_id),case when r.participant_id ~ '^[0-9]+@lid$' then private.whatsapp_market_directory_actor(r.parsed->>'directoryPhone') end);
 select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'balance',c.balance,'available',c.balance-private.market_other_commitment(c.id,r.negotiation_id,r.transfer_id),'delta',case when c.id=r.to_club_id then -r.amount else r.amount end,'after',c.balance+case when c.id=r.to_club_id then -r.amount else r.amount end) order by c.id) into v_clubs from public.clubs c where c.id in(r.from_club_id,r.to_club_id) and c.deleted_at is null;
 if r.to_club_id is null or jsonb_array_length(coalesce(v_clubs,'[]'))<>(case when r.from_club_id is null then 1 else 2 end) then raise exception 'Clubes oficiais não confirmados';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'club_id',p.club_id,'roster_active',p.roster_active,'market_status',p.market_status,'destination',case when p.id=any(r.player_ids_from) then r.to_club_id else r.from_club_id end) order by p.id),'[]'::jsonb) into v_players from public.players p where p.id=any(r.player_ids_from||r.player_ids_to);
 if r.transfer_id is not null then
  if r.free_agent_id is null then raise exception 'Jogador externo não associado';end if;
  select jsonb_build_array(jsonb_build_object('id',a.id,'name',a.name,'week',a.week_rating,'price',a.market_value,'status',a.status,'destination',r.to_club_id)) into v_players from public.free_agents a where a.id=r.free_agent_id;
  if v_players is null then raise exception 'Jogador externo não encontrado';end if;
 end if;
 v_state:=jsonb_build_object('balance_penalties',(select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb) from public.market_balance_penalties p where p.market_cycle_id=w.market_cycle_id and p.club_id in(r.from_club_id,r.to_club_id)),'safety_revision',(select revision from public.whatsapp_market_safety where id),'proposal',to_jsonb(r),'terms',private.market_contract_snapshot(case when r.transfer_id is not null then 'transfer' else 'negotiation' end,coalesce(r.transfer_id,r.negotiation_id)),'clubs',v_clubs,'players',v_players,'official_actor',v_actor,'members_released',(select members_released from public.platform_member_access where id));
 return v_state||jsonb_build_object('success',true,'preview_hash',md5(v_state::text),'generated_at',now());
end$function$
;

CREATE OR REPLACE FUNCTION public.admin_approve_signed_transfer(p_transfer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_t public.transfers%rowtype; v_agent public.free_agents%rowtype; v_player uuid; v_balance bigint;
begin
 if auth.uid() is null or not public.is_admin() then raise exception 'Somente os DMs podem aprovar contratações'; end if;
 perform private.require_admin_aal2_if_enrolled();
 select * into v_t from public.transfers where id=p_transfer_id and deleted_at is null for update;
 if not found then raise exception 'Solicitação não encontrada'; end if;
 if v_t.status='approved' then return jsonb_build_object('success',true,'duplicate',true); end if;
 if v_t.status<>'pending' or v_t.source_negotiation_id is not null then raise exception 'Revise esta operação pela mesa de negociação'; end if;
 if not private.market_contract_is_signed('transfer',v_t.id) then raise exception 'Faltam assinaturas válidas nesta versão'; end if;
 perform 1 from public.clubs where id in (v_t.from_club_id,v_t.to_club_id) order by id for update;
 select balance into v_balance from public.clubs where id=v_t.to_club_id;
 if v_t.free_agent_id is not null then
   select * into v_agent from public.free_agents where id=v_t.free_agent_id for update;
   if not found or v_agent.status<>'available' or v_agent.market_value is distinct from v_t.price then raise exception 'Disponibilidade ou preço mudou. A contratação exige nova solicitação assinada.'; end if;
 end if;
 -- Transition first: trigger checks signatures, quota, window and ban before effects.
 update public.transfers set status='approved',offer_status='completed',reviewed_by=auth.uid(),reviewed_at=now() where id=v_t.id;
 if v_t.free_agent_id is not null then
   insert into public.players(club_id,name,position,week_rating,market_value,category,card_image_url,market_status,meta)
   values(v_t.to_club_id,v_agent.name,v_agent.position,v_agent.week_rating,v_t.price,v_agent.category,v_agent.card_image_url,'available',jsonb_build_object('free_agent_id',v_agent.id,'external_origin',v_agent.original_club_name)) returning id into v_player;
   update public.free_agents set status='acquired',acquired_by_club_id=v_t.to_club_id,acquired_at=now() where id=v_agent.id;
   update public.transfers set player_id=v_player where id=v_t.id;
 else
   if v_t.player_id is null or not exists(select 1 from public.players where id=v_t.player_id and club_id=v_t.from_club_id) then raise exception 'Jogador mudou de clube'; end if;
   update public.players set club_id=v_t.to_club_id,market_status='available' where id=v_t.player_id;
 end if;
 insert into public.transactions(club_id,type,amount,description,created_by,balance_after,transaction_type) values(v_t.to_club_id,'external_transfer_purchase',-v_t.price,'Contratação assinada '||v_t.id,auth.uid(),v_balance-v_t.price,'debit');
 if v_t.from_club_id is not null then
   insert into public.transactions(club_id,type,amount,description,created_by,transaction_type) values(v_t.from_club_id,'negotiation_receipt',v_t.price,'Receita da contratação assinada '||v_t.id,auth.uid(),'credit');
 end if;
 insert into public.audit_logs(actor_id,action,target,details) values(auth.uid(),'signed_transfer_approved','transfers:'||v_t.id,jsonb_build_object('price',v_t.price,'player_id',coalesce(v_player,v_t.player_id)));
 return jsonb_build_object('success',true,'transfer_id',v_t.id);
end $function$
;

CREATE OR REPLACE FUNCTION public.request_signed_external_purchase(p_request_id uuid, p_free_agent_id uuid, p_signature_data_url text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_club public.clubs%rowtype; v_agent public.free_agents%rowtype; v_t public.transfers%rowtype; v_s jsonb;
begin
 if auth.uid() is null or p_request_id is null then raise exception 'Autenticação e identificador da solicitação obrigatórios'; end if;
 select c.* into v_club from public.clubs c join public.coach_profiles cp on cp.club_id=c.id where cp.user_id=auth.uid() and cp.status='active' and cp.deleted_at is null and c.deleted_at is null limit 1;
 if not found then raise exception 'Clube ativo obrigatório'; end if;
 select * into v_t from public.transfers where request_id=p_request_id for update;
 if found then
   if v_t.requested_by<>auth.uid() or v_t.to_club_id<>v_club.id or v_t.free_agent_id<>p_free_agent_id then raise exception 'Solicitação já utilizada em outra operação'; end if;
   return jsonb_build_object('success',true,'duplicate',true,'transfer_id',v_t.id);
 end if;
 perform private.assert_market_module_access('transfer');
 select * into v_agent from public.free_agents where id=p_free_agent_id for update;
 if not found or v_agent.status<>'available' then raise exception 'Jogador externo indisponível'; end if;
 perform 1 from public.clubs where id=v_club.id for update;
 select * into v_club from public.clubs where id=v_club.id;
 if v_agent.market_value<=0 then raise exception 'Saldo disponível insuficiente para esta contratação'; end if;
 if exists(select 1 from public.transfers where free_agent_id=p_free_agent_id and status='pending' and deleted_at is null) then raise exception 'Este jogador já possui uma solicitação pendente'; end if;
 insert into public.transfers(from_club_id,to_club_id,player_name,player_position,player_week_rating,price,requested_by,status,free_agent_id,request_id)
 values(null,v_club.id,v_agent.name,v_agent.position,v_agent.week_rating,v_agent.market_value,auth.uid(),'pending',p_free_agent_id,p_request_id) returning * into v_t;
 v_s:=private.market_contract_snapshot('transfer',v_t.id);
 perform public.sign_market_contract('transfer',v_t.id,v_s->>'terms_hash',p_signature_data_url);
 insert into public.audit_logs(actor_id,action,target,details) values(auth.uid(),'external_purchase_requested','transfers:'||v_t.id,jsonb_build_object('request_id',p_request_id,'price',v_t.price,'result','pending_admin'));
 return jsonb_build_object('success',true,'transfer_id',v_t.id);
end $function$
;

CREATE OR REPLACE FUNCTION private.reserve_market_contract_assets()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
 end loop;
 delete from private.whatsapp_market_asset_reservations where source_type=v_type and source_id=new.id and not ((asset_kind='player' and asset_id=any(v_assets)) or (asset_kind='free_agent' and coalesce(asset_id=v_agent,false)));
 for v_asset,v_key in select x,'player' from unnest(v_assets) x union all select v_agent,'free_agent' where v_agent is not null order by 2,1 loop
  insert into private.whatsapp_market_asset_reservations(asset_kind,asset_id,source_type,source_id) values(v_key,v_asset,v_type,new.id) on conflict(asset_kind,asset_id) do nothing;
  select source_id into v_owner from private.whatsapp_market_asset_reservations where asset_kind=v_key and asset_id=v_asset and source_type=v_type and source_id=new.id;
  if not found then raise exception 'Jogador já reservado por outra proposta. Rejeite ou cancele a anterior antes de continuar';end if;
 end loop;
 return new;
end$function$
;

CREATE OR REPLACE FUNCTION private.guard_market_debit_commitment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_balance bigint;
  v_committed bigint;
  v_exclude_negotiation uuid;
  v_match text[];
begin
  if new.type='bulk_balance_import' and current_setting('mlg.balance_reconciliation',true)=new.club_id::text then return new; end if;
  if new.type in ('negotiation_payment','external_transfer_purchase') then return new;end if;
  if new.amount >= 0 then return new; end if;
  if new.type = 'negotiation_payment' then
    v_match := regexp_match(coalesce(new.description, ''), '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', 'i');
    if v_match is not null then v_exclude_negotiation := v_match[1]::uuid; end if;
  end if;
  select c.balance into v_balance from public.clubs c where c.id = new.club_id for update;
  v_committed := private.club_financial_commitment(new.club_id, v_exclude_negotiation, null, null);
  if coalesce(v_balance, 0) - v_committed < abs(new.amount) then
    raise exception 'Débito bloqueado: saldo disponível insuficiente após compromissos ativos';
  end if;
  return new;
end;
$function$
;

create or replace function private.guard_negotiation_commitment() returns trigger language plpgsql security definer set search_path='' as $$ begin perform 1 from public.clubs where id in(new.club_a_id,new.club_b_id) order by id for update;return new;end $$;

create or replace function private.guard_member_offer_budget() returns trigger language plpgsql security definer set search_path='' as $$ begin perform 1 from public.clubs where id in(new.club_a_id,new.club_b_id) order by id for update;return new;end $$;

