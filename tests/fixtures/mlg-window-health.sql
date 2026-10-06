create table public.whatsapp_market_health (
 id boolean primary key default true check(id),last_heartbeat timestamptz,phase text not null default 'STARTING',enabled boolean not null default true,
 bridge_healthy boolean not null default false,proposal_queue integer not null default 0,response_queue integer not null default 0,
 oldest_age_seconds integer not null default 0,delivery_blocked boolean not null default false,admin_groups text[] not null default '{}',
 status text not null default 'waiting',reason text not null default '',bad_since timestamptz,
 incident_id uuid,created_at timestamptz not null default clock_timestamp()
);
insert into public.whatsapp_market_health(id) values(true);
create table public.whatsapp_market_health_incidents (
 id uuid primary key default gen_random_uuid(),kind text not null,reason text not null,opened_at timestamptz not null default clock_timestamp(),resolved_at timestamptz
);
create table private.whatsapp_market_health_deliveries (
 id uuid primary key default gen_random_uuid(),incident_id uuid not null references public.whatsapp_market_health_incidents(id),
 event text not null check(event in('failure','recovery')),group_id text not null,body text not null,
 lease_id uuid,lease_until timestamptz,delivered_at timestamptz,created_at timestamptz not null default clock_timestamp(),
 unique(incident_id,event,group_id)
);
alter table public.whatsapp_market_health enable row level security;
alter table public.whatsapp_market_health_incidents enable row level security;
alter table private.whatsapp_market_health_deliveries enable row level security;
revoke all on public.whatsapp_market_health,public.whatsapp_market_health_incidents,private.whatsapp_market_health_deliveries from public,anon,authenticated;
grant select on public.whatsapp_market_health,public.whatsapp_market_health_incidents to authenticated;
create policy market_health_admin_read on public.whatsapp_market_health for select to authenticated using((select public.is_admin()));
create policy market_health_incident_admin_read on public.whatsapp_market_health_incidents for select to authenticated using((select public.is_admin()));

create function private.check_whatsapp_market_health() returns void language plpgsql security definer set search_path='' as $$
declare h public.whatsapp_market_health%rowtype;v_kind text;v_reason text;v_body text;v_id uuid;v_now timestamptz:=clock_timestamp();
begin
 select * into h from public.whatsapp_market_health where id for update;
 if not h.enabled then v_kind:='disabled';v_reason:='Bot pausado intencionalmente pelo controle';
 elsif coalesce(h.last_heartbeat,h.created_at)<v_now-interval '3 minutes' then v_kind:='heartbeat_missing';v_reason:='Bot sem sinal de saúde há mais de 3 minutos';
 elsif h.last_heartbeat is null then return;
 elsif h.phase<>'CONNECTED' then v_kind:='disconnected';v_reason:='WhatsApp desconectado ou reconectando';
 elsif not h.bridge_healthy then v_kind:='bridge_failed';v_reason:='Captura, banco ou entrega de avisos precisa de recuperação';
 elsif h.oldest_age_seconds>300 and (h.response_queue>0 or (h.proposal_queue>0 and not h.delivery_blocked)) then v_kind:='queue_delayed';v_reason:='Há mensagens aguardando entrega há mais de 5 minutos';
 else v_kind:='healthy';v_reason:='Conexão e processamento confirmados';end if;
 if v_kind not in('healthy','disabled') then
  if h.bad_since is null then update public.whatsapp_market_health set bad_since=v_now,status=v_kind,reason=v_reason where id;return;end if;
  update public.whatsapp_market_health set status=v_kind,reason=v_reason where id;
  -- Brief reconnections do not create repeated alerts. Missing heartbeat is already delayed.
  if h.incident_id is null and (v_kind='heartbeat_missing' or h.bad_since<v_now-interval '2 minutes') then
   insert into public.whatsapp_market_health_incidents(kind,reason) values(v_kind,v_reason) returning id into v_id;
   update public.whatsapp_market_health set incident_id=v_id where id;
   v_body:='⚠️ SAÚDE DO BOT MLG: '||v_reason||'. As propostas salvas permanecem na fila. Confira a central antes de aprovar.';
   insert into public.notifications(user_id,category,title,body) select a.user_id,'market','Alerta de saúde do bot',v_body from public.admin_users a;
   insert into private.whatsapp_market_health_deliveries(incident_id,event,group_id,body) select v_id,'failure',g,v_body from unnest(h.admin_groups) g on conflict do nothing;
  end if;
 else
  if h.incident_id is not null then
   update public.whatsapp_market_health_incidents set resolved_at=v_now where id=h.incident_id;
   v_body:=case when v_kind='healthy' then '✅ SAÚDE DO BOT MLG: conexão e processamento recuperados. A fila salva será retomada sem reaplicar operações concluídas.' else 'ℹ️ SAÚDE DO BOT MLG: bot pausado intencionalmente. Confira as mensagens pendentes ao religar.' end;
   insert into public.notifications(user_id,category,title,body) select a.user_id,'market',case when v_kind='healthy' then 'Bot recuperado' else 'Bot pausado pelo controle' end,v_body from public.admin_users a;
   insert into private.whatsapp_market_health_deliveries(incident_id,event,group_id,body) select h.incident_id,'recovery',g,v_body from unnest(h.admin_groups) g on conflict do nothing;
  end if;
  update public.whatsapp_market_health set status=v_kind,reason=v_reason,bad_since=null,incident_id=null where id;
 end if;
end$$;

create function private.receive_whatsapp_market_health(p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_groups text[];
begin
 if coalesce(p_payload->>'phase','') not in('STARTING','CONNECTING','CONNECTED','BACKOFF','NEEDS_PAIRING','STOPPED') or jsonb_typeof(p_payload->'enabled') is distinct from 'boolean' or jsonb_typeof(p_payload->'healthy') is distinct from 'boolean' or jsonb_typeof(p_payload->'blocked') is distinct from 'boolean' or jsonb_typeof(p_payload->'groups') is distinct from 'array' then raise exception 'Sinal de saúde inválido';end if;
 if coalesce((p_payload->>'proposalQueue')::integer,-1) not between 0 and 1000000 or coalesce((p_payload->>'responseQueue')::integer,-1) not between 0 and 1000000 or coalesce((p_payload->>'oldestAgeSeconds')::integer,-1) not between 0 and 315360000 then raise exception 'Fila de saúde inválida';end if;
 select coalesce(array_agg(distinct g),'{}') into v_groups from jsonb_array_elements_text(p_payload->'groups') g where g~'^[0-9-]{5,40}@g\.us$';
 if cardinality(v_groups)>20 then raise exception 'Canais de saúde inválidos';end if;
 update public.whatsapp_market_health set last_heartbeat=clock_timestamp(),phase=p_payload->>'phase',enabled=(p_payload->>'enabled')::boolean,bridge_healthy=(p_payload->>'healthy')::boolean,proposal_queue=(p_payload->>'proposalQueue')::integer,response_queue=(p_payload->>'responseQueue')::integer,oldest_age_seconds=(p_payload->>'oldestAgeSeconds')::integer,delivery_blocked=(p_payload->>'blocked')::boolean,admin_groups=v_groups where id;
 perform private.check_whatsapp_market_health();return jsonb_build_object('success',true);
end$$;
create function private.claim_whatsapp_market_health_notices(p_groups jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_lease uuid:=gen_random_uuid();v_result jsonb;
begin
 with picked as(select id from private.whatsapp_market_health_deliveries where group_id in(select jsonb_array_elements_text(p_groups)) and delivered_at is null and (lease_until is null or lease_until<clock_timestamp()) order by created_at,event limit 10 for update skip locked), leased as(update private.whatsapp_market_health_deliveries n set lease_id=v_lease,lease_until=clock_timestamp()+interval '90 seconds' from picked p where n.id=p.id returning n.*)
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'group',group_id,'body',body,'lease',lease_id) order by created_at,event),'[]') into v_result from leased;
 return jsonb_build_object('notices',v_result);
end$$;
create function public.admin_get_whatsapp_market_safety() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not coalesce(public.is_admin(),false) then raise exception 'Somente ADMs podem consultar a segurança';end if;
 return jsonb_build_object('success',true,'safety',(select to_jsonb(s) from public.whatsapp_market_safety s where id),'health',(select to_jsonb(h)-'admin_groups' from public.whatsapp_market_health h where id),'reservations',(select count(*) from private.whatsapp_market_asset_reservations),'incidents',coalesce((select jsonb_agg(to_jsonb(x)) from (select id,kind,reason,opened_at,resolved_at from public.whatsapp_market_health_incidents order by opened_at desc limit 10)x),'[]'));
end$$;
revoke all on function private.check_whatsapp_market_health(),private.receive_whatsapp_market_health(jsonb),private.claim_whatsapp_market_health_notices(jsonb) from public,anon,authenticated;
revoke all on function public.admin_get_whatsapp_market_safety() from public,anon;
grant execute on function public.admin_get_whatsapp_market_safety() to authenticated;
