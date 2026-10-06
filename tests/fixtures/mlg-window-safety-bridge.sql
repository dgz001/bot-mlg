CREATE OR REPLACE FUNCTION public.bot_whatsapp_market_gate(p_token text, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_result jsonb;v_lease uuid;v_notice private.whatsapp_market_private_notices%rowtype;
begin
 if p_token is null or length(p_token)<>64 or not exists(select 1 from private.whatsapp_market_credentials where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex')) then raise exception 'Credencial inválida' using errcode='42501';end if;
 if pg_column_size(p_payload)>50000 then raise exception 'Payload grande demais';end if;
 if p_action='heartbeat' then return private.receive_whatsapp_market_health(p_payload);end if;
 if p_action='claim_health' then return private.claim_whatsapp_market_health_notices(coalesce(p_payload->'groups','[]'));end if;
 if p_action='ack_health' then
  update private.whatsapp_market_health_deliveries set delivered_at=case when p_payload->>'sent'='true' then clock_timestamp() else null end,lease_id=null,lease_until=null where id=(p_payload->>'id')::uuid and lease_id=(p_payload->>'lease')::uuid;return jsonb_build_object('success',found);end if;
 if p_action='config' then
  v_result:=public.bot_whatsapp_market_bridge(p_token,'config','{}'::jsonb);
  return v_result||jsonb_build_object('safety',(select jsonb_build_object('paused',paused,'revision',revision) from public.whatsapp_market_safety where id),'captureSince',(select market_cycle_started_at from public.market_windows order by updated_at desc nulls last limit 1),'batches',coalesce((
   select jsonb_agg(jsonb_build_object('group',c.group_id,'batch',coalesce(b.batch_no,1),'count',coalesce(b.accepted_count,0),'limit',coalesce(b.batch_limit,10),'botLocked',coalesce(b.bot_locked,false)))
   from public.whatsapp_market_channels c left join public.whatsapp_market_batches b on b.group_id=c.group_id
  ),'[]'::jsonb));
 elsif p_action='claim_admin' then
  return private.claim_whatsapp_market_admin_notices(coalesce(p_payload->'groups','[]'::jsonb));
 elsif p_action='ack_admin' then
  update private.whatsapp_market_admin_notices set delivered_at=case when p_payload->>'sent'='true' then clock_timestamp() else null end,lease_id=null,lease_until=null where id=(p_payload->>'id')::uuid and lease_id=(p_payload->>'lease')::uuid;
  return jsonb_build_object('success',found);
 elsif p_action='ingest' then
  begin return public.bot_whatsapp_market_bridge(p_token,p_action,p_payload);
  exception when raise_exception then
   if SQLERRM='Remessa completa; aguarde a conferência dos ADMs' then return jsonb_build_object('success',false,'reason','batch_closed');end if;
   raise;
  end;
 elsif p_action='gate_ack' then
  if coalesce(p_payload->>'group','')!~'^[0-9-]{5,40}@g\.us$' or jsonb_typeof(p_payload->'locked') is distinct from 'boolean' then raise exception 'Estado inválido';end if;
  update public.whatsapp_market_batches set bot_locked=(p_payload->>'locked')::boolean,updated_at=clock_timestamp() where group_id=p_payload->>'group';
  if not found then raise exception 'Grupo sem remessa';end if;
  return jsonb_build_object('success',true);
 elsif p_action='claim_private' then
  v_lease:=gen_random_uuid();
  with picked as(select id from private.whatsapp_market_private_notices where delivered_at is null and (lease_until is null or lease_until<clock_timestamp()) order by created_at limit 20 for update skip locked),
  leased as(update private.whatsapp_market_private_notices n set lease_id=v_lease,lease_until=clock_timestamp()+interval '90 seconds' from picked where n.id=picked.id returning n.*)
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'recipient',recipient,'body',body,'lease',lease_id)),'[]'::jsonb) into v_result from leased;
  return jsonb_build_object('notices',v_result);
 elsif p_action='ack_private' then
  select * into v_notice from private.whatsapp_market_private_notices where id=(p_payload->>'id')::uuid for update;
  if not found or v_notice.lease_id is distinct from (p_payload->>'lease')::uuid then return jsonb_build_object('success',false,'stale',true);end if;
  update private.whatsapp_market_private_notices set delivered_at=case when p_payload->>'sent'='true' then clock_timestamp() else null end,lease_id=null,lease_until=null where id=v_notice.id;
  return jsonb_build_object('success',true);
 end if;
 return public.bot_whatsapp_market_bridge(p_token,p_action,p_payload);
end$function$
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
 if exists(select 1 from jsonb_array_elements(v_clubs) c where (c->>'delta')::bigint<0 and (c->>'available')::bigint<-(c->>'delta')::bigint) then raise exception 'Saldo disponível insuficiente';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'club_id',p.club_id,'roster_active',p.roster_active,'market_status',p.market_status,'destination',case when p.id=any(r.player_ids_from) then r.to_club_id else r.from_club_id end) order by p.id),'[]'::jsonb) into v_players from public.players p where p.id=any(r.player_ids_from||r.player_ids_to);
 if r.transfer_id is not null then
  if r.free_agent_id is null then raise exception 'Jogador externo não associado';end if;
  select jsonb_build_array(jsonb_build_object('id',a.id,'name',a.name,'week',a.week_rating,'price',a.market_value,'status',a.status,'destination',r.to_club_id)) into v_players from public.free_agents a where a.id=r.free_agent_id;
  if v_players is null then raise exception 'Jogador externo não encontrado';end if;
 end if;
 v_state:=jsonb_build_object('safety_revision',(select revision from public.whatsapp_market_safety where id),'proposal',to_jsonb(r),'terms',private.market_contract_snapshot(case when r.transfer_id is not null then 'transfer' else 'negotiation' end,coalesce(r.transfer_id,r.negotiation_id)),'clubs',v_clubs,'players',v_players,'official_actor',v_actor,'members_released',(select members_released from public.platform_member_access where id));
 return v_state||jsonb_build_object('success',true,'preview_hash',md5(v_state::text),'generated_at',now());
end$function$
;

