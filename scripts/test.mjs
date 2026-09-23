import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

// Render builds run in isolation from the running bot. Never inherit runtime
// credentials into tests, and never fall back to DATABASE_URL.
const isolated = process.argv.includes('--isolated') || process.env.RENDER === 'true';
const env = Object.fromEntries(['PATH','HOME','TMPDIR','SystemRoot'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const files = (await readdir('tests')).filter(p=>p.endsWith('.test.ts')).map(p=>'tests/'+p);
async function run(args, extra={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{stdio:'inherit',env:{...env,...extra}});
    const deadline=setTimeout(()=>child.kill('SIGKILL'),180000);
    child.once('error',reject);
    child.once('exit',code=>{clearTimeout(deadline);resolve(code??1);});
  });
}
if (!isolated) {
  process.exitCode=await run(['--test',...files],process.env.MLG_TEST_DATABASE_URL?{MLG_TEST_DATABASE_URL:process.env.MLG_TEST_DATABASE_URL}:{});
} else {
  if(process.getuid?.()===0)throw Error('Isolated PostgreSQL requires a non-root build runner; no user or permission changes are performed.');
  process.umask(0o077);
  const root=await mkdtemp(join(tmpdir(),'mlg-integration-'));
  let pg;
  try {
    // Only this reviewed package needs its symlink installer, not all npm scripts.
    const binary=fileURLToPath(import.meta.resolve('@embedded-postgres/'+process.platform+'-'+process.arch));
    if(await run([join(dirname(binary),'../scripts/hydrate-symlinks.js')])!==0)throw Error('PostgreSQL binary preparation failed');
    const {default:EmbeddedPostgres}=await import('embedded-postgres');
    const password=randomBytes(24).toString('hex');
    pg=new EmbeddedPostgres({databaseDir:join(root,'data'),port:15432,user:'postgres',password,persistent:false,authMethod:'scram-sha-256',createPostgresUser:false,postgresFlags:['-h','127.0.0.1','-k',root],onLog:()=>{},onError:()=>{}});
    await pg.initialise();await pg.start();
    console.log('ISOLATED_POSTGRES_READY — temporary local database, no production data');
    process.exitCode=await run(['--test',...files],{MLG_TEST_DATABASE_URL:`postgresql://postgres:${password}@127.0.0.1:15432/postgres`});
  } finally {
    if(pg)await pg.stop();
    await rm(root,{recursive:true,force:true});
  }
}
