-- Distinguish ADM review above the base quota from exceeding an authorized club limit.
create or replace function private.signal_whatsapp_market_quota() returns trigger language plpgsql security definer set search_path='' as $$
declare w public.market_windows%rowtype;v_buyer uuid;v_seller uuid;u jsonb;v_names text[];v_count integer;v_actor jsonb;v_name text;v_coach text;v_flags jsonb:='[]';v_summary text;v_limit integer;
begin
 new.quota_flags:='[]';if new.kind<>'transfer' then return new;end if;
 select * into w from public.market_windows order by updated_at desc nulls last limit 1;
 if not found or (new.market_cycle_id is not null and new.market_cycle_id<>w.market_cycle_id) then return new;end if;
 v_actor:=new.parsed->'officialActor';
 v_buyer:=nullif(v_actor->>'club_id','')::uuid;
 if v_buyer is not null and exists(select 1 from public.clubs where id=v_buyer and deleted_at is null and private.market_name_key(name)=private.market_name_key(new.parsed->>'destination')) then
  u:=private.market_window_completed_usage(v_buyer,w.market_cycle_id);
  v_limit:=(private.market_effective_limits(v_buyer,w.market_cycle_id)->>'purchase_limit')::int;
  if (u->>'purchases')::int>=w.max_transfers_per_club then
   select name into v_name from public.clubs where id=v_buyer;
   v_flags:=v_flags||jsonb_build_array(jsonb_build_object('type','purchase','club_id',v_buyer,'club',v_name,'coach',coalesce(v_actor->>'coach','Responsável oficial'),'used',(u->>'purchases')::int,'limit',v_limit,'base_limit',w.max_transfers_per_club,'exceeded',(u->>'purchases')::int>=v_limit,'decision','admin_review'));
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
  select string_agg((f->>'coach')||' · '||(f->>'club')||': '||case f->>'type' when 'purchase' then 'compras' else 'vendas' end||' '||(f->>'used')||'/'||(f->>'limit')||case when f->>'type'='purchase' and coalesce((f->>'exceeded')::boolean,true)=false then '; compra adicional dentro da opção registrada, precisa de confirmação dos ADMs.' else '; proposta excedente precisa de conferência.' end, ' ') into v_summary from jsonb_array_elements(v_flags) f;
  new.classification_note:=concat_ws(' ',new.classification_note,v_summary);
  if new.automatic_rejection then new.review_note:=new.classification_note;else new.status:='needs_review';end if;
 end if;
 return new;
end $$;
revoke all on function private.signal_whatsapp_market_quota() from public,anon,authenticated;
