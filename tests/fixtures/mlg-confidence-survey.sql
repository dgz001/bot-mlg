-- Private, durable delivery queue. No member may edit another club's answer.
create table public.market_confidence_surveys (
 id uuid primary key default gen_random_uuid(), market_cycle_id uuid,
 active boolean not null default true, created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(), closed_at timestamptz
);
create unique index market_confidence_one_active on public.market_confidence_surveys(active) where active;
create table public.market_confidence_answers (
 survey_id uuid not null references public.market_confidence_surveys(id),
 club_id uuid not null references public.clubs(id), coach_name text not null,
 recipient text not null check(recipient ~ '^[0-9]+@s[.]whatsapp[.]net$'),
 answer boolean, answered_at timestamptz, source_message_id text,
 primary key(survey_id,club_id),unique(survey_id,recipient)
);
alter table public.market_confidence_surveys enable row level security;
alter table public.market_confidence_answers enable row level security;
revoke all on public.market_confidence_surveys,public.market_confidence_answers from public,anon,authenticated;
grant select on public.market_confidence_surveys,public.market_confidence_answers to authenticated;
create policy confidence_surveys_admin_read on public.market_confidence_surveys for select to authenticated using(public.is_admin());
create policy confidence_answers_admin_read on public.market_confidence_answers for select to authenticated using(public.is_admin());
create table private.market_confidence_deliveries (
 id uuid primary key default gen_random_uuid(),survey_id uuid not null references public.market_confidence_surveys(id),
 club_id uuid not null references public.clubs(id),destination text not null,body text not null,
 kind text not null check(kind in('question','answer')),source_message_id text not null default '',
 created_at timestamptz not null default now(),delivered_at timestamptz,lease_id uuid,lease_until timestamptz,
 unique(survey_id,club_id,destination,kind,source_message_id)
);
alter table private.market_confidence_deliveries enable row level security;
revoke all on private.market_confidence_deliveries from public,anon,authenticated;
create function public.admin_start_market_confidence_survey(p_expected_cycle uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.market_windows%rowtype;s public.market_confidence_surveys%rowtype;v_count integer;
begin
 if auth.uid() is null or not public.is_admin() then raise exception 'Somente ADMs';end if;
 perform private.require_admin_aal2_if_enrolled();
 perform pg_advisory_xact_lock(hashtextextended('market_confidence_survey',0));
 select * into w from public.market_windows order by updated_at desc nulls last limit 1 for share;
 if w.market_cycle_id is distinct from p_expected_cycle then raise exception 'A janela mudou. Atualize o painel.';end if;
 select * into s from public.market_confidence_surveys where active;
 if found then return jsonb_build_object('success',true,'id',s.id,'duplicate',true);end if;
 select count(*) into v_count from public.whatsapp_market_club_directory d join public.clubs c on c.id=d.club_id where c.deleted_at is null;
 if v_count<>25 or exists(select 1 from public.whatsapp_market_club_directory where phone!~'^[0-9]{10,15}$' or trim(coach_name)='') or exists(select phone from public.whatsapp_market_club_directory group by phone having count(*)>1) then raise exception 'Confira os 25 técnicos e seus números oficiais antes do envio.';end if;
 insert into public.market_confidence_surveys(market_cycle_id,created_by) values(case when w.transfer_window_open or w.trade_window_open then w.market_cycle_id else null end,auth.uid()) returning * into s;
 insert into public.market_confidence_answers(survey_id,club_id,coach_name,recipient) select s.id,d.club_id,d.coach_name,d.phone||'@s.whatsapp.net' from public.whatsapp_market_club_directory d join public.clubs c on c.id=d.club_id where c.deleted_at is null;
 insert into private.market_confidence_deliveries(survey_id,club_id,destination,kind,body) select s.id,a.club_id,a.recipient,'question','Olá, '||a.coach_name||'! Para esta janela da MLG, você quer converter uma troca em uma compra adicional? SIM: 5 compras e 1 troca. NÃO: 4 compras e 2 trocas. As vendas permanecem em 4. Responda apenas SIM ou NÃO neste privado. A compra adicional continua sujeita à conferência dos ADMs.' from public.market_confidence_answers a where a.survey_id=s.id;
 insert into public.audit_logs(actor_id,action,target,details) values(auth.uid(),'market_confidence_survey_started',s.id::text,jsonb_build_object('recipients',25));
 return jsonb_build_object('success',true,'id',s.id,'queued',25);
end $$;
revoke all on function public.admin_start_market_confidence_survey(uuid) from public,anon;
grant execute on function public.admin_start_market_confidence_survey(uuid) to authenticated;

create function private.market_confidence_bot(p_action text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.market_confidence_surveys%rowtype;a public.market_confidence_answers%rowtype;v_answer boolean;v_result jsonb;v_lease uuid;v_groups text[];v_name text;v_id uuid;
begin
 if p_action='survey_claim' then
  v_lease:=gen_random_uuid();
  select array_agg(value) into v_groups from jsonb_array_elements_text(coalesce(p_payload->'groups','[]'));
  insert into private.market_confidence_deliveries(survey_id,club_id,destination,kind,source_message_id,body) select answer_row.survey_id,answer_row.club_id,g,'answer',answer_row.source_message_id,'📋 Troca de confiança — '||answer_row.coach_name||' · '||c.name||': '||case when answer_row.answer then 'SIM. Optou por 5 compras e 1 troca.' else 'NÃO. Mantém 4 compras e 2 trocas.' end||' Resposta registrada na plataforma MLG.' from public.market_confidence_answers answer_row join public.market_confidence_surveys survey_row on survey_row.id=answer_row.survey_id join public.clubs c on c.id=answer_row.club_id cross join unnest(v_groups) g where survey_row.active and answer_row.answer is not null and g ~ '^[0-9-]+@g[.]us$' on conflict do nothing;
  with picked as(select d.id from private.market_confidence_deliveries d join public.market_confidence_surveys survey_row on survey_row.id=d.survey_id where survey_row.active and d.delivered_at is null and (d.lease_until is null or d.lease_until<clock_timestamp()) and (d.kind='question' or d.destination=any(v_groups)) order by d.created_at limit 10 for update of d skip locked), leased as(update private.market_confidence_deliveries d set lease_id=v_lease,lease_until=clock_timestamp()+interval '90 seconds' from picked where d.id=picked.id returning d.*)
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'recipient',destination,'body',body,'lease',lease_id,'kind',kind)),'[]') into v_result from leased;
  return jsonb_build_object('notices',v_result);
 elsif p_action='survey_ack' then
  update private.market_confidence_deliveries set delivered_at=case when p_payload->>'sent'='true' then clock_timestamp() else null end,lease_id=null,lease_until=null where id=(p_payload->>'id')::uuid and lease_id=(p_payload->>'lease')::uuid;
  return jsonb_build_object('success',found);
 elsif p_action='survey_answer' then
  if lower(trim(p_payload->>'text')) not in('sim','não','nao') or coalesce(p_payload->>'messageId','')='' then return jsonb_build_object('success',true,'matched',false);end if;
  select * into s from public.market_confidence_surveys where active for share;
  if not found then return jsonb_build_object('success',true,'matched',false);end if;
  select * into a from public.market_confidence_answers where survey_id=s.id and recipient in(select value from jsonb_array_elements_text(p_payload->'aliases')) for update;
  if not found then return jsonb_build_object('success',true,'matched',false);end if;
  -- Never interpret an unrelated SIM before the question has actually been delivered.
  if not exists(select 1 from private.market_confidence_deliveries where survey_id=s.id and club_id=a.club_id and kind='question' and delivered_at is not null) then return jsonb_build_object('success',true,'matched',false);end if;
  if a.answer is not null then return jsonb_build_object('success',true,'matched',true,'duplicate',true);end if;
  v_answer:=lower(trim(p_payload->>'text'))='sim';
  update public.market_confidence_answers set answer=v_answer,answered_at=clock_timestamp(),source_message_id=p_payload->>'messageId' where survey_id=s.id and club_id=a.club_id;
  select name into v_name from public.clubs where id=a.club_id;
  select array_agg(value) into v_groups from jsonb_array_elements_text(coalesce(p_payload->'groups','[]'));
  insert into private.market_confidence_deliveries(survey_id,club_id,destination,kind,source_message_id,body) select s.id,a.club_id,g,'answer',p_payload->>'messageId','📋 Troca de confiança — '||a.coach_name||' · '||v_name||': '||case when v_answer then 'SIM. Optou por 5 compras e 1 troca.' else 'NÃO. Mantém 4 compras e 2 trocas.' end||' Resposta registrada. Confira e autorize a opção na plataforma MLG.' from unnest(v_groups) g where g ~ '^[0-9-]+@g[.]us$' on conflict do nothing;
  insert into public.audit_logs(action,target,details) values('market_confidence_answer_received',s.id::text,jsonb_build_object('club',a.club_id,'answer',v_answer,'message_id',p_payload->>'messageId'));
  return jsonb_build_object('success',true,'matched',true);
 end if;
 raise exception 'Ação de consulta inválida';
end $$;
revoke all on function private.market_confidence_bot(text,jsonb) from public,anon,authenticated;

create function private.bind_market_confidence_survey() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.market_cycle_id is distinct from old.market_cycle_id then update public.market_confidence_surveys set market_cycle_id=new.market_cycle_id where active and market_cycle_id is null;end if;
 if (old.transfer_window_open or old.trade_window_open) and not new.transfer_window_open and not new.trade_window_open then update public.market_confidence_surveys set active=false,closed_at=clock_timestamp() where active and market_cycle_id=new.market_cycle_id;end if;
 return new;
end $$;
revoke all on function private.bind_market_confidence_survey() from public,anon,authenticated;
create trigger market_confidence_cycle after update of transfer_window_open,trade_window_open on public.market_windows for each row execute function private.bind_market_confidence_survey();

create function public.admin_get_market_window_backup(p_cycle uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not public.is_admin() then raise exception 'Somente ADMs';end if;
 perform private.require_admin_aal2_if_enrolled();
 if p_cycle is null then raise exception 'Selecione uma janela';end if;
 return jsonb_build_object('format','mlg-market-backup-v1','exported_at',clock_timestamp(),'market_cycle_id',p_cycle,
 'proposals',coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at) from public.whatsapp_market_inbox i where i.market_cycle_id=p_cycle),'[]'),
 'negotiations',coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at) from public.negotiations n where n.market_cycle_id=p_cycle),'[]'),
 'transfers',coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at) from public.transfers t where t.market_cycle_id=p_cycle),'[]'),
 'club_options',coalesce((select jsonb_agg(to_jsonb(o)) from public.market_window_club_options o where o.market_cycle_id=p_cycle),'[]'),
 'confidence_answers',coalesce((select jsonb_agg(jsonb_build_object('club_id',a.club_id,'coach',a.coach_name,'answer',a.answer,'answered_at',a.answered_at)) from public.market_confidence_answers a join public.market_confidence_surveys s on s.id=a.survey_id where s.market_cycle_id=p_cycle),'[]'));
end $$;
revoke all on function public.admin_get_market_window_backup(uuid) from public,anon;
grant execute on function public.admin_get_market_window_backup(uuid) to authenticated;

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
 if p_action in('survey_claim','survey_ack','survey_answer') then return private.market_confidence_bot(p_action,p_payload);end if;
 if p_action='roster_progress' then return private.roster_collection_progress(p_payload);end if;
 if p_action='heartbeat' then return private.receive_whatsapp_market_health(p_payload);end if;
 if p_action='claim_health' then return private.claim_whatsapp_market_health_notices(coalesce(p_payload->'groups','[]'));end if;
 if p_action='ack_health' then
  update private.whatsapp_market_health_deliveries set delivered_at=case when p_payload->>'sent'='true' then clock_timestamp() else null end,lease_id=null,lease_until=null where id=(p_payload->>'id')::uuid and lease_id=(p_payload->>'lease')::uuid;return jsonb_build_object('success',found);end if;
 if p_action='config' then
  if p_payload->>'rosterVersion'='1' then update public.roster_collection_settings set bot_seen=clock_timestamp() where id;end if;
  v_result:=public.bot_whatsapp_market_bridge(p_token,'config','{}'::jsonb);
  return v_result||jsonb_build_object('rosterCollection',private.roster_collection_config(),'safety',(select jsonb_build_object('paused',paused,'revision',revision) from public.whatsapp_market_safety where id),'captureSince',(select market_cycle_started_at from public.market_windows order by updated_at desc nulls last limit 1),'batches',coalesce((
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
end$function$;

create or replace function private.market_effective_limits(p_club uuid,p_cycle uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('purchase_limit',greatest(w.max_transfers_per_club+case when coalesce(o.trust_trade,a.answer,false) then 1 else 0 end,coalesce(o.purchase_exception_limit,0)),
 'sale_limit',w.max_sales_per_club,'trade_limit',greatest(w.max_trades_per_club-case when coalesce(o.trust_trade,a.answer,false) then 1 else 0 end,0),'trust_trade',coalesce(o.trust_trade,a.answer,false))
 from public.market_windows w left join public.market_window_club_options o on o.club_id=p_club and o.market_cycle_id=w.market_cycle_id left join public.market_confidence_surveys s on s.market_cycle_id=w.market_cycle_id left join public.market_confidence_answers a on a.survey_id=s.id and a.club_id=p_club where w.market_cycle_id=p_cycle order by w.updated_at desc nulls last limit 1;
$$;

