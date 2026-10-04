begin;
set local role mlg_bot_gateway;
do $test$
declare v_group text:='999999999991@g.us';v_manager text:='rollback-platform-organizer';v_actor text:='platform:11111111-1111-4111-8111-111111111111';
begin
 insert into mlg_bot.groups(id,authorized) values(v_group,true);
 insert into mlg_bot.users(id,display_name) values(v_manager,'Organizador de teste'),(v_actor,'ADM da plataforma');
 insert into mlg_bot.loan_groups(group_id,manager_id,granted_by) values(v_group,v_manager,v_actor) on conflict(group_id) do update set manager_id=excluded.manager_id,granted_by=excluded.granted_by,active=true,granted_at=now(),revoked_at=null;
 insert into mlg_bot.loan_invitations(manager_id,granted_by,claimed_group) values(v_manager,v_actor,v_group) on conflict(manager_id) do update set granted_by=excluded.granted_by,claimed_group=excluded.claimed_group,active=true,granted_at=now(),revoked_at=null;
 insert into mlg_bot.admins(group_id,user_id,role) values(v_group,v_manager,'channel') on conflict(group_id,user_id) do nothing;
 update mlg_bot.groups set admins_configured=true where id=v_group;
 insert into mlg_bot.control_audit(action,group_id,user_id) values('platform-loan-grant',v_group,v_actor);
 if not exists(select 1 from mlg_bot.loan_invitations where manager_id=v_manager and active and claimed_group=v_group) then raise exception 'Private organizer access missing';end if;
 update mlg_bot.loan_groups set active=false,revoked_at=now() where group_id=v_group;
 update mlg_bot.loan_invitations set active=false,revoked_at=now() where claimed_group=v_group;
 delete from mlg_bot.admins where group_id=v_group and role='channel';
 if exists(select 1 from mlg_bot.loan_groups where group_id=v_group and active) or exists(select 1 from mlg_bot.admins where group_id=v_group and role='channel') then raise exception 'Revocation incomplete';end if;
end $test$;
select 'gateway role: granting, private invitation, audit and revocation passed' result;
rollback;
