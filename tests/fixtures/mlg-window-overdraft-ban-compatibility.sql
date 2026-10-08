CREATE OR REPLACE FUNCTION private.club_has_active_ban(p_club_id uuid, p_action text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select (p_club_id is not null and exists(
  select 1 from public.club_transfer_bans b where b.club_id=p_club_id
  and b.status='active' and b.starts_at<=now() and (b.ends_at is null or b.ends_at>now())
  and (p_action='registration' or b.scope='all_market')
  and (coalesce((b.scope_rules->>'activate_on_next_market_cycle')::boolean,false)=false
   or case when b.scope_rules ? 'target_market_cycle_id'
    then b.scope_rules->>'target_market_cycle_id'=(select market_cycle_id::text from public.market_windows order by updated_at desc nulls last limit 1)
    else b.scope_rules->>'origin_market_cycle_id' is distinct from (select market_cycle_id::text from public.market_windows order by updated_at desc nulls last limit 1) end))) or exists(select 1 from public.market_balance_penalties bp where bp.club_id=p_club_id and bp.penalty='all_market' and bp.market_cycle_id=(select market_cycle_id from public.market_windows order by updated_at desc nulls last limit 1));
$function$
;
CREATE OR REPLACE FUNCTION private.club_has_active_ban(p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (private.club_has_active_ban(p_club_id, 'registration')) or exists(select 1 from public.market_balance_penalties bp where bp.club_id=p_club_id and bp.penalty='all_market' and bp.market_cycle_id=(select market_cycle_id from public.market_windows order by updated_at desc nulls last limit 1));
$function$
;
CREATE OR REPLACE FUNCTION public.review_market_negotiation(p_negotiation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n public.negotiations%rowtype;v_w public.market_windows%rowtype;v_a jsonb;v_b jsonb;v_checks jsonb;v_cash bigint;v_ok boolean;
begin
 if auth.uid() is null or not public.is_admin() then raise exception 'Somente os DMs podem revisar a operação'; end if;
 select * into v_n from public.negotiations where id=p_negotiation_id;
 if not found then raise exception 'Negociação não encontrada'; end if;
 select * into v_w from public.market_windows order by updated_at desc nulls last limit 1;
 v_a:=private.market_window_usage(v_n.club_a_id,v_w.market_cycle_id,v_n.id);
 v_b:=private.market_window_usage(v_n.club_b_id,v_w.market_cycle_id,v_n.id);
 v_cash:=v_n.cash_from_a-v_n.cash_from_b;
 v_checks:=jsonb_build_array(
 jsonb_build_object('key','accepted','label','Termos aceitos pelo outro clube','ok',v_n.status='accepted'),
 jsonb_build_object('key','signatures','label','Assinaturas dos dois responsáveis nesta versão','ok',private.market_contract_is_signed('negotiation',v_n.id)),
 jsonb_build_object('key','window','label','Janela atual aberta e operação habilitada','ok',v_n.market_cycle_id=v_w.market_cycle_id and not v_w.maintenance_mode and not v_w.read_only_mode and case when v_n.type='trade' then v_w.trade_window_open else v_w.transfer_window_open end and exists(select 1 from public.market_module_policies where module=v_n.type and enabled and member_actions_enabled)),
 jsonb_build_object('key','players','label','Jogadores ativos nos clubes que assinaram','ok',(select count(*) from public.players where club_id=v_n.club_a_id and roster_active and v_n.player_ids_a ? id::text)=jsonb_array_length(v_n.player_ids_a) and (select count(*) from public.players where club_id=v_n.club_b_id and roster_active and v_n.player_ids_b ? id::text)=jsonb_array_length(v_n.player_ids_b)),
 jsonb_build_object('key','balance','label','Saldo conferido; saldo negativo gera Transfer Ban após aprovação','ok',true),
 jsonb_build_object('key','quotas','label','Cotas de compras, vendas ou trocas disponíveis','ok',case when v_n.type='trade' then (v_a->>'trades')::int+1<=v_w.max_trades_per_club and (v_b->>'trades')::int+1<=v_w.max_trades_per_club else (v_a->>'purchases')::int+1<=v_w.max_transfers_per_club and (v_b->>'sales')::int+1<=v_w.max_sales_per_club end),
 jsonb_build_object('key','ban','label','Clubes sem bloqueio de registro nesta janela','ok',not private.club_has_active_ban(v_n.club_a_id) and (v_n.type<>'trade' or not private.club_has_active_ban(v_n.club_b_id)))
 );
 select bool_and(coalesce((value->>'ok')::boolean,false)) into v_ok from jsonb_array_elements(v_checks);
 return jsonb_build_object('can_approve',v_ok,'checks',v_checks);
end $function$
;
