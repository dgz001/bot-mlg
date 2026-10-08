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
  return private.claim_market_balance_penalty_notices(coalesce(p_payload->'groups','[]'::jsonb));
 elsif p_action='ack_admin' then
  update private.market_balance_penalty_deliveries set delivered_at=case when p_payload->>'sent'='true' then clock_timestamp() else null end,lease_id=null,lease_until=null where id=(p_payload->>'id')::uuid and lease_id=(p_payload->>'lease')::uuid;
  if found then return jsonb_build_object('success',true);end if;
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
