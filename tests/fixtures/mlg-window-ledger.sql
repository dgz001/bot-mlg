CREATE OR REPLACE FUNCTION private.guard_market_debit_commitment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_balance bigint;
  v_committed bigint;
  v_exclude_negotiation uuid;
  v_match text[];
begin
  if new.type='bulk_balance_import' and current_setting('mlg.balance_reconciliation',true)=new.club_id::text then return new; end if;
  if new.amount >= 0 then return new; end if;
  if new.type = 'negotiation_payment' then
    v_match := regexp_match(coalesce(new.description, ''), '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', 'i');
    if v_match is not null then v_exclude_negotiation := v_match[1]::uuid; end if;
  end if;
  select c.balance into v_balance from public.clubs c where c.id = new.club_id for update;
  v_committed := private.club_financial_commitment(new.club_id, v_exclude_negotiation, null, null);
  if coalesce(v_balance, 0) - v_committed < abs(new.amount) then
    raise exception 'Débito bloqueado: saldo disponível insuficiente após compromissos ativos';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private.protect_financial_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
 if tg_op='DELETE' then raise exception 'Histórico financeiro não pode ser apagado. Arquive ou registre uma correção auditada.';end if;
 if (to_jsonb(new)-'archived_at') is distinct from (to_jsonb(old)-'archived_at') then
  raise exception 'Movimentação financeira imutável. Registre uma correção auditada.';
 end if;
 return new;
end$function$;

CREATE OR REPLACE FUNCTION public.sync_club_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  UPDATE public.clubs
  SET balance = balance + NEW.amount,
      updated_at = now()
  WHERE id = NEW.club_id;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION private.stamp_financial_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_balance bigint;
begin
 if new.amount is null then raise exception 'Valor financeiro obrigatório';end if;
 select balance into v_balance from public.clubs where id=new.club_id and deleted_at is null for update;
 if not found then raise exception 'Clube financeiro ativo obrigatório';end if;
 new.balance_after:=v_balance+new.amount;
 new.created_at:=clock_timestamp();
 return new;
end$function$;

create trigger a_guard before insert on public.transactions for each row execute function private.guard_market_debit_commitment();
create trigger b_stamp before insert on public.transactions for each row execute function private.stamp_financial_balance();
create trigger c_sync after insert on public.transactions for each row execute function public.sync_club_balance();
create trigger immutable_ledger before update or delete on public.transactions for each row execute function private.protect_financial_ledger();
