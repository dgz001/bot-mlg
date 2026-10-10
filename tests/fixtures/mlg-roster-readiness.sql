alter table public.roster_collection_settings add column bot_seen timestamptz;
CREATE OR REPLACE FUNCTION public.admin_configure_roster_collection(p_enabled boolean, p_group text, p_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if auth.uid() is null or not coalesce(public.is_admin(),false) then raise exception 'Somente ADMs';end if;
 perform private.require_admin_aal2_if_enrolled();
 if p_enabled and not exists(select 1 from public.roster_collection_settings where id and bot_seen>clock_timestamp()-interval '90 seconds') then raise exception 'Atualize o bot no Railway antes de habilitar a coleta';end if;
 if p_enabled is null or (p_enabled and (p_group is null or p_group !~ '^[0-9-]{5,40}@g[.]us$')) then raise exception 'Escolha o grupo de elencos';end if;
 update public.roster_collection_settings set enabled=p_enabled,group_id=p_group,revision=revision+1 where id and revision=p_revision;
 if not found then raise exception 'Configuração mudou; atualize a página';end if;
 insert into public.audit_logs(actor_id,action,target,details) values(auth.uid(),'roster_collection_configured','settings',jsonb_build_object('enabled',p_enabled,'group',p_group));
 return jsonb_build_object('success',true);
end$function$
;

