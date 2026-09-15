import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';

export async function migrate() {
  const url=process.env.DATABASE_URL;
  const appPassword=process.env.APP_DATABASE_PASSWORD;
  if(!url || !appPassword || appPassword.length<32) throw new Error('Migration configuration missing');
  const pool=new Pool({connectionString:url,connectionTimeoutMillis:15000});
  const q=await pool.connect();
  try {
    await q.query('SELECT pg_advisory_lock(71012026)');
    const exists=await q.query("SELECT to_regclass('mlg_bot.schema_migrations') AS present");
    if(!exists.rows[0].present) await q.query(await readFile(new URL('../migrations/001_initial.sql',import.meta.url),'utf8'));
    const second=await q.query('SELECT 1 FROM mlg_bot.schema_migrations WHERE version=2');
    if(!second.rowCount) await q.query(await readFile(new URL('../migrations/002_worker.sql',import.meta.url),'utf8'));
    const role=await q.query("SELECT 1 FROM pg_roles WHERE rolname='mlg_bot_app'");
    if(!role.rowCount) await q.query('CREATE ROLE mlg_bot_app LOGIN');
    // quote_literal is performed by PostgreSQL. Never log the generated SQL.
    const quoted=await q.query('SELECT quote_literal($1) AS value',[appPassword]);
    await q.query('ALTER ROLE mlg_bot_app PASSWORD '+quoted.rows[0].value);
    await q.query('GRANT USAGE ON SCHEMA mlg_bot TO mlg_bot_app');
    await q.query('GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA mlg_bot TO mlg_bot_app');
    await q.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA mlg_bot TO mlg_bot_app');
    await q.query('GRANT DELETE ON mlg_bot.command_drafts,mlg_bot.wa_auth,mlg_bot.conversation_context TO mlg_bot_app');
    await q.query('REVOKE UPDATE ON mlg_bot.audit_logs,mlg_bot.control_audit,mlg_bot.schema_migrations FROM mlg_bot_app');
    await q.query('REVOKE INSERT ON mlg_bot.schema_migrations FROM mlg_bot_app');
  } finally { await q.query('SELECT pg_advisory_unlock(71012026)').catch(()=>undefined);q.release();await pool.end(); }
}
if(process.argv[1]?.endsWith('/migrate.ts')) {
  migrate().then(()=>console.log('MIGRATIONS_OK')).catch(()=>{console.error('MIGRATIONS_FAILED');process.exitCode=1;});
}
