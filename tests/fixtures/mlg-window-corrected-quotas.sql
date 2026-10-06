CREATE OR REPLACE FUNCTION private.market_window_usage(p_club_id uuid, p_cycle_id uuid, p_exclude_negotiation uuid DEFAULT NULL::uuid, p_exclude_transfer uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
select jsonb_build_object(
 'purchases',coalesce((select sum(jsonb_array_length(n.player_ids_b)) from public.negotiations n where n.club_a_id=p_club_id and n.type='transfer' and n.market_cycle_id=p_cycle_id and n.status in ('open','waiting','accepted','executed') and not private.whatsapp_market_source_corrected('negotiation',n.id) and n.id is distinct from p_exclude_negotiation),0)+(select count(*) from public.transfers t where t.to_club_id=p_club_id and t.market_cycle_id=p_cycle_id and t.source_negotiation_id is null and t.status in ('pending','approved') and t.deleted_at is null and not private.whatsapp_market_source_corrected('transfer',t.id) and t.id is distinct from p_exclude_transfer),
 'sales',coalesce((select sum(jsonb_array_length(n.player_ids_b)) from public.negotiations n where n.club_b_id=p_club_id and n.type='transfer' and n.market_cycle_id=p_cycle_id and n.status in ('open','waiting','accepted','executed') and not private.whatsapp_market_source_corrected('negotiation',n.id) and n.id is distinct from p_exclude_negotiation),0)+(select count(*) from public.transfers t where t.from_club_id=p_club_id and t.market_cycle_id=p_cycle_id and t.source_negotiation_id is null and t.status in ('pending','approved') and t.deleted_at is null and not private.whatsapp_market_source_corrected('transfer',t.id) and t.id is distinct from p_exclude_transfer),
 'trades',(select count(*) from public.negotiations n where p_club_id in (n.club_a_id,n.club_b_id) and n.type='trade' and n.market_cycle_id=p_cycle_id and n.status in ('open','waiting','accepted','executed') and not private.whatsapp_market_source_corrected('negotiation',n.id) and n.id is distinct from p_exclude_negotiation)
);
$function$

CREATE OR REPLACE FUNCTION private.guard_midseason_market_rules()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_window public.market_windows%rowtype; v_rules jsonb; v_player uuid; v_count_a integer; v_count_b integer; v_limit integer;
begin
  select * into v_window from public.market_windows order by updated_at desc nulls last limit 1;
  if not found then raise exception 'Configuração da janela não encontrada.'; end if;
  new.market_cycle_id:=coalesce(new.market_cycle_id,v_window.market_cycle_id);
  if tg_table_name='transfers' then return new; end if;
  v_rules:=coalesce((select rules from public.market_module_policies where module=case when new.type='trade' then 'trade' else 'transfer' end),'{}'::jsonb);
  if new.type='trade' and coalesce((v_rules->>'allow_cash')::boolean,false)=false
     and (coalesce(new.cash_from_a,0)<>0 or coalesce(new.cash_from_b,0)<>0) then
    raise exception 'Trocas desta janela não podem envolver dinheiro.';
  end if;
  if new.type='trade' then
    v_limit:=coalesce((v_rules->>'max_trades_per_club')::integer,3);
    select count(*) into v_count_a from public.negotiations n where n.market_cycle_id=v_window.market_cycle_id and n.type='trade' and n.status in ('open','waiting','accepted','executed') and not private.whatsapp_market_source_corrected('negotiation',n.id) and n.id<>new.id and new.club_a_id in (n.club_a_id,n.club_b_id);
    select count(*) into v_count_b from public.negotiations n where n.market_cycle_id=v_window.market_cycle_id and n.type='trade' and n.status in ('open','waiting','accepted','executed') and not private.whatsapp_market_source_corrected('negotiation',n.id) and n.id<>new.id and new.club_b_id in (n.club_a_id,n.club_b_id);
    if v_count_a>=v_limit or v_count_b>=v_limit then raise exception 'Um dos clubes atingiu o limite de trocas desta janela.'; end if;
  end if;
  if coalesce((v_rules->>'block_same_window_retrade')::boolean,true) then
    for v_player in select value::uuid from jsonb_array_elements_text(coalesce(new.player_ids_a,'[]'::jsonb)) loop
      if exists(select 1 from public.transfers t where t.player_id=v_player and t.to_club_id=new.club_a_id and t.market_cycle_id=v_window.market_cycle_id and t.status='approved' and t.deleted_at is null and not private.whatsapp_market_source_corrected('transfer',t.id)) then raise exception 'Jogador recém-contratado não pode sair novamente na mesma janela.'; end if;
    end loop;
    for v_player in select value::uuid from jsonb_array_elements_text(coalesce(new.player_ids_b,'[]'::jsonb)) loop
      if exists(select 1 from public.transfers t where t.player_id=v_player and t.to_club_id=new.club_b_id and t.market_cycle_id=v_window.market_cycle_id and t.status='approved' and t.deleted_at is null and not private.whatsapp_market_source_corrected('transfer',t.id)) then raise exception 'Jogador recém-contratado não pode sair novamente na mesma janela.'; end if;
    end loop;
  end if;
  return new;
end $function$

