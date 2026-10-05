create schema private;
create table public.admin_users(user_id uuid primary key);
create table public.platform_member_access(id boolean primary key,members_released boolean);
create table public.whatsapp_market_inbox(id uuid primary key,revision integer,status text,from_club_id uuid,negotiation_id uuid,transfer_id uuid);
create table private.whatsapp_market_adm_attestations(inbox_id uuid,proposal_revision integer,source_type text,source_id uuid,terms_hash text,approved_by uuid,buyer_confirmed boolean,seller_confirmed boolean);
create table private.test_snapshots(source_type text,source_id uuid,terms_hash text);
create function private.market_contract_snapshot(p_type text,p_source uuid) returns jsonb language sql as $$select jsonb_build_object('terms_hash',terms_hash) from private.test_snapshots where source_type=p_type and source_id=p_source$$;
create function private.whatsapp_market_adm_attestation_valid(p_type text,p_source uuid,p_actor uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_snapshot jsonb;begin
 if p_actor is null or not exists(select 1 from public.admin_users where user_id=p_actor)
 or not exists(select 1 from public.platform_member_access where id and not members_released) then return false;end if;
 v_snapshot:=private.market_contract_snapshot(p_type,p_source);
 return exists(select 1 from private.whatsapp_market_adm_attestations a
 join public.whatsapp_market_inbox r on r.id=a.inbox_id
 where a.source_type=p_type and a.source_id=p_source and a.approved_by=p_actor
 and a.terms_hash=v_snapshot->>'terms_hash' and a.proposal_revision=r.revision
 and r.status='awaiting_signatures' and a.buyer_confirmed
 and (r.from_club_id is null or a.seller_confirmed)
 and ((p_type='negotiation' and r.negotiation_id=p_source) or (p_type='transfer' and r.transfer_id=p_source)));
end$$;

