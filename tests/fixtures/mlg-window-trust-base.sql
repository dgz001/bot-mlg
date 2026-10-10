alter table public.market_windows add column max_transfers_per_club integer default 4,add column max_sales_per_club integer default 4,add column max_trades_per_club integer default 2,add column loan_window_open boolean default false;
alter table public.market_module_policies add column enabled boolean default true,add column member_actions_enabled boolean default true;
alter table auth.users add column deleted_at timestamptz,add column email_confirmed_at timestamptz default now(),add column banned_until timestamptz;
alter table public.notifications add column deep_link text;
create table public.coach_profiles(user_id uuid,club_id uuid,status text,deleted_at timestamptz);
create table public.whatsapp_market_club_directory(club_id uuid primary key,coach_name text,phone text);
alter table public.whatsapp_market_inbox add column purchase_scope text,add column automatic_rejection boolean default false,add column classification_note text,add column roster_conflicts uuid[] default '{}',add column created_at timestamptz default now();
alter table private.whatsapp_market_private_notices add column inbox_id uuid,alter column id set default gen_random_uuid(),alter column created_at set default now();
create unique index private_notice_once on private.whatsapp_market_private_notices(inbox_id,recipient);
alter table private.whatsapp_market_admin_notices add column inbox_id uuid,add column revision integer,add column bucket timestamptz,add column group_id text,add column body text,add column created_at timestamptz default now(),alter column id set default gen_random_uuid();
create unique index admin_notice_once on private.whatsapp_market_admin_notices(inbox_id,revision,bucket,group_id);
create or replace function private.market_name_key(text) returns text language sql immutable as $$select regexp_replace(lower(trim($1)),'[^a-z0-9]','','g')$$;
create or replace function private.whatsapp_market_directory_actor(text) returns jsonb language sql stable as $$select jsonb_build_object('club_id',club_id,'coach',coach_name) from public.whatsapp_market_club_directory where phone||'@s.whatsapp.net'=$1$$;
create function private.annotate_test_actor() returns trigger language plpgsql as $$begin new.parsed:=new.parsed||jsonb_build_object('officialActor',private.whatsapp_market_directory_actor(new.participant_id));return new;end$$;
create trigger annotate_official_market_actor before insert or update of parsed on public.whatsapp_market_inbox for each row execute function private.annotate_test_actor();
CREATE OR REPLACE FUNCTION private.classify_whatsapp_market()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_origin text;v_names text[];v_count integer;v_player text;v_club text;
begin
 new.automatic_rejection:=false;new.roster_conflicts:='{}';new.classification_note:=null;
 if new.kind='trade' then new.purchase_scope:='trade';return new;end if;
 v_origin:=private.market_name_key(new.parsed->>'origin');
 if new.parsed->>'purchaseScope'='external' then new.purchase_scope:='external';
 elsif new.parsed->>'purchaseScope'='internal' then new.purchase_scope:='internal';
 elsif (select count(*) from public.clubs where deleted_at is null and private.market_name_key(name)=v_origin)=1 then new.purchase_scope:='internal';
 else new.purchase_scope:='review';new.classification_note:='Origem ou tipo de compra precisa de revisão.';end if;
 if new.purchase_scope='external' then
  select array_agg(private.market_name_key(value)) into v_names from jsonb_array_elements_text(coalesce(new.parsed->'playersFrom','[]'::jsonb));
  select array_agg(p.id),count(*) into new.roster_conflicts,v_count from public.players p join public.clubs c on c.id=p.club_id where p.roster_active and c.deleted_at is null and private.market_name_key(p.name)=any(v_names);
  new.roster_conflicts:=coalesce(new.roster_conflicts,'{}');
  if v_count=1 and cardinality(v_names)=1 and jsonb_array_length(coalesce(new.parsed->'issues','[]'::jsonb))=0 then
   select p.name,c.name into v_player,v_club from public.players p join public.clubs c on c.id=p.club_id where p.id=new.roster_conflicts[1];
   new.classification_note:='Compra externa rejeitada: '||v_player||' já consta no elenco de '||v_club||'. Confira uma compra interna ou retire a classificação automática se houver erro.';
   new.status:='rejected';new.automatic_rejection:=true;new.review_note:=new.classification_note;
  elsif v_count>0 then
   new.status:='needs_review';new.classification_note:='Possível jogador já inscrito na MLG; há ambiguidade. Conferência de um ADM necessária.';
  else new.classification_note:='Compra externa declarada. Carta, identidade e assinaturas precisam de conferência.';end if;
 end if;
 return new;
end $function$

create trigger whatsapp_market_classification before insert or update of parsed,kind on public.whatsapp_market_inbox for each row execute function private.classify_whatsapp_market();
