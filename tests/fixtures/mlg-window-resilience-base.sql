-- Synthetic, disposable-only schema extensions. No production session is impersonated.
alter table public.clubs add column coach_user_id uuid;
alter table public.players add column week_rating text;
alter table public.market_windows add column market_cycle_started_at timestamptz default clock_timestamp();
alter table public.negotiations add column initiated_by uuid,add column last_action_by uuid,add column target_player_id uuid,add column closed_at timestamptz,add column closed_by uuid;
alter table public.transfers add column player_name text,add column player_position text,add column player_week_rating text,add column requested_by uuid,add column reviewed_by uuid,add column reviewed_at timestamptz,add column offer_status text;
create table public.trades(id uuid default gen_random_uuid(),source_negotiation_id uuid,club_a_id uuid,club_b_id uuid,players_a jsonb,players_b jsonb,requested_by uuid,status text,reviewed_by uuid,reviewed_at timestamptz,offer_status text);
create table public.auctions(id uuid,current_bid bigint,current_bidder_club_id uuid,status text,closes_at timestamptz);
alter table public.club_loan_contracts add column borrower_club_id uuid,add column lender_club_id uuid,add column fixed_fee bigint,add column cash_principal bigint,add column market_cycle_id uuid;
alter table public.whatsapp_market_inbox add column group_id text,add column message_id text,add column content_hash text,add column raw_text text,add column card_reading jsonb,add column mentioned_jids text[],add column reviewed_by uuid,add column review_note text,add column card_week text;
create unique index inbox_message_once on public.whatsapp_market_inbox(group_id,message_id);
alter table public.whatsapp_market_inbox alter column id set default gen_random_uuid();
create table public.whatsapp_market_responses(id uuid,inbox_id uuid,proposal_revision integer,identity_verified boolean,decision text,participant_id text,created_at timestamptz);
create table public.whatsapp_market_actor_links(user_id uuid,participant_id text);
create table public.whatsapp_market_channels(group_id text primary key,kind text);
create table public.whatsapp_market_batches(group_id text,batch_no integer,accepted_count integer,batch_limit integer,bot_locked boolean,updated_at timestamptz);
create table private.whatsapp_market_credentials(token_hash text);
create table private.whatsapp_market_private_notices(id uuid,recipient text,body text,lease_id uuid,lease_until timestamptz,delivered_at timestamptz,created_at timestamptz);
create table private.whatsapp_market_admin_notices(id uuid,lease_id uuid,lease_until timestamptz,delivered_at timestamptz);
create table private.whatsapp_market_reactions(inbox_id uuid,revision integer,emoji text,lease_id uuid,lease_until timestamptz,delivered_at timestamptz,updated_at timestamptz);
create function private.market_contract_is_signed(text,uuid) returns boolean language sql as $$select true$$;
create function private.link_whatsapp_market_worksheet(public.whatsapp_market_inbox,public.negotiations) returns void language plpgsql as $$begin return;end$$;
create function private.ingest_whatsapp_market_response(jsonb) returns jsonb language sql as $$select '{"success":true}'::jsonb$$;
create function private.claim_whatsapp_market_admin_notices(jsonb) returns jsonb language sql as $$select '{"notices":[]}'::jsonb$$;

alter table public.transfers alter column id set default gen_random_uuid();
