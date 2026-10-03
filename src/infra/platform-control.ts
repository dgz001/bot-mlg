import {connect} from 'node:net';
import type {IncomingMessage,ServerResponse} from 'node:http';

type Identity={id:string;admin:boolean};
const adminActions=new Set(['status','groups','participants','authorize','settings','revoke','setadmins','history-candidates','history-review','competition-get','competition-save','templates-list','template-get','template-save','template-activate','template-delete','cup-open','cup-cancel','cup-void','set-group-mode','select-context','leave-group','pair','restart','news-config']);
export function platformIdentity(url:string,key:string,fetcher:typeof fetch=fetch){
 const source=new URL(url);
 if(source.protocol!=='https:'||!/^([a-z0-9-]+)\.supabase\.co$/.test(source.hostname)||!key)throw Error('Invalid platform identity provider');
 return async(header:string|undefined):Promise<Identity|null>=>{
  if(!header?.startsWith('Bearer ')||header.length>8192)return null;
  const jwt=header.slice(7);if(!/^[A-Za-z0-9._-]+$/.test(jwt))return null;
  const headers={apikey:key,Authorization:'Bearer '+jwt,Accept:'application/json'};
  const userResponse=await fetcher(new URL('/auth/v1/user',source),{headers,signal:AbortSignal.timeout(10000)});
  if(!userResponse.ok)return null;
  const user=await userResponse.json() as {id?:unknown;factors?:{status?:string}[]};
  if(typeof user.id!=='string'||!(/^[0-9a-f-]{36}$/i.test(user.id)))return null;
  // The Auth server has verified the JWT. A registered factor requires a fresh AAL2 session.
  let payload:{sub?:string;aal?:string};try{payload=JSON.parse(Buffer.from(jwt.split('.')[1]??'','base64url').toString('utf8'));}catch{return null;}
  if(payload.sub!==user.id||user.factors?.some(f=>f.status==='verified')&&payload.aal!=='aal2')return null;
  const roleResponse=await fetcher(new URL('/rest/v1/rpc/is_admin',source),{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
  if(!roleResponse.ok)throw Error('Admin check unavailable');
  return {id:user.id,admin:await roleResponse.json()===true};
 };
}
export function platformControl(options:{origin:string;socketPath:string;identify:(header:string|undefined)=>Promise<Identity|null>;restart:()=>unknown}){
 const origin=new URL(options.origin);if(origin.origin!==options.origin||origin.protocol!=='https:')throw Error('Invalid platform origin');
 let active=false,lastPair=0;
 return async(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Vary','Origin');res.setHeader('X-Content-Type-Options','nosniff');
  if(req.headers.origin!==options.origin){res.writeHead(403).end();return;}
  res.setHeader('Access-Control-Allow-Origin',options.origin);res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
  const reply=(code:number,data:unknown)=>res.writeHead(code,{'Content-Type':'application/json'}).end(JSON.stringify(data));
  if(req.method!=='POST'||req.headers['content-type']!=='application/json'){reply(405,{error:'Operação inválida'});return;}
  try{
   const identity=await options.identify(req.headers.authorization);
   if(!identity){reply(401,{error:'Entre novamente na plataforma MLG.'});return;}
   let body='';for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>24000){reply(413,{error:'Solicitação grande demais'});return;}}
   const data=JSON.parse(body) as Record<string,unknown>;
   if(typeof data.action!=='string'||!adminActions.has(data.action)||!identity.admin&&data.action!=='status'){reply(403,{error:'Comando restrito aos ADMs da plataforma MLG.'});return;}
   if(data.action==='restart'){
    if(!identity.admin){reply(403,{error:'Operação reservada'});return;}
    try{reply(202,options.restart());}catch{reply(429,{error:'Aguarde antes de reiniciar novamente.'});}return;
   }
   if(data.action==='pair'){if(Date.now()-lastPair<60000){reply(429,{error:'Aguarde um minuto para gerar outro código.'});return;}lastPair=Date.now();}
   if(active){reply(429,{error:'Aguarde a operação atual.'});return;}
   active=true;
   try{
   const result=await new Promise<Record<string,unknown>>((resolve,reject)=>{
    const client=connect(options.socketPath);let output='';client.setTimeout(45000,()=>client.destroy(Error('timeout')));
    client.on('connect',()=>client.write(JSON.stringify(data)+'\n'));
    client.on('data',chunk=>{output+=chunk.toString();if(output.length>131072)client.destroy(Error('response too large'));});
    client.on('error',reject);client.on('end',()=>{try{resolve(JSON.parse(output));}catch{reject(Error('invalid response'));}});
   });
   if(!identity.admin){reply(200,{phase:result.phase,controls:result.controls,minicamp:result.minicamp,checkedAt:result.checkedAt});return;}
   reply(200,result);
   }finally{active=false;}
  }catch{reply(503,{error:'Controle do bot indisponível. Tente novamente em instantes.'});}
 };
}
