import {createServer} from 'node:http';
import {privateControl} from './infra/private-control.ts';
import {RuntimeSupervisor} from './infra/runtime-supervisor.ts';
import {panelCredentials} from './infra/panel-credentials.ts';
import {platformControl,platformIdentity} from './infra/platform-control.ts';

process.umask(0o077);
const secret=process.env.CONTROL_PASSWORD,origin=process.env.CONTROL_ORIGIN;
if(!secret||!origin)throw Error('Control configuration missing');
const vaultUrl=process.env.SESSION_VAULT_URL,vaultToken=process.env.SESSION_VAULT_TOKEN;
if(!vaultUrl||!vaultToken)throw Error('Panel credential storage missing');
const credentials=panelCredentials(vaultUrl,vaultToken,secret);
const supervisor=new RuntimeSupervisor({worker:new URL('./resenha-worker.ts',import.meta.url),env:{...process.env},log:event=>console.log(JSON.stringify({event,at:new Date().toISOString()}))});
const portal=privateControl({secret,origin,socketPath:'/tmp/mlg-bot-control.sock',resenha:true,restart:()=>supervisor.restart(),authenticate:credentials.verify,rotatePassword:credentials.rotate});
const platform=process.env.PLATFORM_ORIGIN&&process.env.MLG_NEWS_SUPABASE_URL&&process.env.MLG_NEWS_SUPABASE_KEY?platformControl({origin:process.env.PLATFORM_ORIGIN,socketPath:'/tmp/mlg-bot-control.sock',identify:platformIdentity(process.env.MLG_NEWS_SUPABASE_URL,process.env.MLG_NEWS_SUPABASE_KEY),restart:()=>supervisor.restart()}):undefined;
let stopping=false;
const server=createServer((req,res)=>{
  if(req.url==='/livez'||req.url==='/readyz'){
    const ok=!stopping&&(req.url==='/livez'||supervisor.ready);
    res.writeHead(ok?200:503,{'Cache-Control':'no-store'}).end(ok?'OK':'UNAVAILABLE');return;
  }
  if(req.url==='/platform-control'&&platform){void platform(req,res).catch(()=>{if(!res.headersSent)res.writeHead(503);res.end();});return;}
  void portal(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});
});
async function stop(){if(stopping)return;stopping=true;server.close();await supervisor.stop();server.closeAllConnections();process.exit(0);}
process.on('SIGTERM',()=>{void stop();});process.on('SIGINT',()=>{void stop();});
server.listen(Number(process.env.PORT??3000),'0.0.0.0',()=>supervisor.start());
