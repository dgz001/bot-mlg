alter table public.market_confidence_answers add column quota_applied boolean not null default false;
create or replace function private.market_confidence_bot(p_action text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.market_confidence_surveys%rowtype;a public.market_confidence_answers%rowtype;v_answer boolean;v_result jsonb;v_lease uuid;v_groups text[];v_name text;v_id uuid;v_apply boolean;v_usage jsonb;v_trades integer;
begin
 if p_action='survey_claim' then
  v_lease:=gen_random_uuid();
  select array_agg(value) into v_groups from jsonb_array_elements_text(coalesce(p_payload->'groups','[]'));
  insert into private.market_confidence_deliveries(survey_id,club_id,destination,kind,source_message_id,body) select answer_row.survey_id,answer_row.club_id,g,'answer',answer_row.source_message_id,'📋 Troca de confiança — '||answer_row.coach_name||' · '||c.name||': '||case when answer_row.answer and not answer_row.quota_applied then 'SIM. Conversão pendente: trocas já utilizadas ou reservadas; confira na plataforma.' when answer_row.answer then 'SIM. Optou por 5 compras e 1 troca.' else 'NÃO. Mantém 4 compras e 2 trocas.' end||' Resposta registrada na plataforma MLG.' from public.market_confidence_answers answer_row join public.market_confidence_surveys survey_row on survey_row.id=answer_row.survey_id join public.clubs c on c.id=answer_row.club_id cross join unnest(v_groups) g where survey_row.active and answer_row.answer is not null and g ~ '^[0-9-]+@g[.]us$' on conflict do nothing;
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
  v_answer:=lower(trim(p_payload->>'text'))='sim';v_apply:=v_answer;
  if v_answer and s.market_cycle_id is not null then select max_trades_per_club into v_trades from public.market_windows where market_cycle_id=s.market_cycle_id order by updated_at desc limit 1 for share;perform 1 from public.clubs where id=a.club_id for update;v_usage:=private.market_window_usage(a.club_id,s.market_cycle_id);v_apply:=(v_usage->>'trades')::int<=greatest(v_trades-1,0);end if;
  update public.market_confidence_answers set answer=v_answer,quota_applied=v_apply,answered_at=clock_timestamp(),source_message_id=p_payload->>'messageId' where survey_id=s.id and club_id=a.club_id;
  select name into v_name from public.clubs where id=a.club_id;
  select array_agg(value) into v_groups from jsonb_array_elements_text(coalesce(p_payload->'groups','[]'));
  insert into private.market_confidence_deliveries(survey_id,club_id,destination,kind,source_message_id,body) select s.id,a.club_id,g,'answer',p_payload->>'messageId','📋 Troca de confiança — '||a.coach_name||' · '||v_name||': '||case when v_answer then 'SIM. Optou por 5 compras e 1 troca.' else 'NÃO. Mantém 4 compras e 2 trocas.' end||case when v_answer and not v_apply then ' Conversão não aplicada: trocas já concluídas ou reservadas. Os ADMs precisam conferir.' else ' Resposta registrada. Compras adicionais continuam exigindo confirmação dos ADMs.' end from unnest(v_groups) g where g ~ '^[0-9-]+@g[.]us$' on conflict do nothing;
  insert into public.audit_logs(action,target,details) values('market_confidence_answer_received',s.id::text,jsonb_build_object('club',a.club_id,'answer',v_answer,'message_id',p_payload->>'messageId'));
  return jsonb_build_object('success',true,'matched',true);
 end if;
 raise exception 'Ação de consulta inválida';
end $$;

create or replace function private.market_effective_limits(p_club uuid,p_cycle uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('purchase_limit',greatest(w.max_transfers_per_club+case when coalesce(o.trust_trade,a.answer and a.quota_applied,false) then 1 else 0 end,coalesce(o.purchase_exception_limit,0)),
 'sale_limit',w.max_sales_per_club,'trade_limit',greatest(w.max_trades_per_club-case when coalesce(o.trust_trade,a.answer and a.quota_applied,false) then 1 else 0 end,0),'trust_trade',coalesce(o.trust_trade,a.answer and a.quota_applied,false))
 from public.market_windows w left join public.market_window_club_options o on o.club_id=p_club and o.market_cycle_id=w.market_cycle_id left join public.market_confidence_surveys s on s.market_cycle_id=w.market_cycle_id left join public.market_confidence_answers a on a.survey_id=s.id and a.club_id=p_club where w.market_cycle_id=p_cycle order by w.updated_at desc nulls last limit 1;
$$;

