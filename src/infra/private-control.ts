import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

export function validControlToken(header: string | undefined, secret: string): boolean {
  if (secret.length < 32 || !header?.startsWith('Bearer ') || header.length > 512) return false;
  const digest=(s:string)=>createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(header.slice(7)),digest(secret));
}
export function privateControl(options:{secret:string;origin:string;socketPath:string;resenha?:boolean}) {
  const origin=new URL(options.origin);
  if(origin.protocol!=='https:' || origin.origin!==options.origin)throw new Error('Control origin must be HTTPS origin');
  let failures=0,windowEnd=0,pairAt=0,active=false;
  return async(req:IncomingMessage,res:ServerResponse)=>{
    const nonce=randomBytes(18).toString('base64');
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    if(req.url==='/' && req.method==='GET') {
      res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page(nonce,options.resenha));return;
    }
    const reply=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(value));};
    if(req.url!=='/control' || req.method!=='POST'){reply(404,{error:'Não encontrado'});return;}
    if(req.headers.origin!==options.origin || req.headers['x-mlg-control']!=='1' || req.headers['content-type']!=='application/json'){reply(403,{error:'Origem recusada'});return;}
    const now=Date.now();if(now>windowEnd){failures=0;windowEnd=now+60000;}
    if(failures>=5){reply(429,{error:'Aguarde um minuto antes de tentar novamente'});return;}
    if(!validControlToken(req.headers.authorization,options.secret)){failures++;reply(401,{error:'Senha inválida'});return;}
    if(active){reply(429,{error:'Aguarde a operação atual'});return;}
    let body='',ownsOperation=false;
    req.setTimeout(10000,()=>req.destroy());
    try {
      for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>8192){reply(413,{error:'Solicitação grande demais'});return;}}
      const data=JSON.parse(body);
      if(!['status','pair','groups','participants','authorize'].includes(data.action)){reply(400,{error:'Operação inválida'});return;}
      if(data.action==='pair'){if(now-pairAt<60000){reply(429,{error:'Aguarde um minuto para gerar outro código'});return;}pairAt=now;}
      if(active){reply(429,{error:'Aguarde a operação atual'});return;}
      active=true;ownsOperation=true;
      const result=await new Promise<unknown>((resolve,reject)=>{
        const client=connect(options.socketPath);let output='';
        client.setTimeout(45000,()=>client.destroy(new Error('timeout')));
        client.on('connect',()=>client.write(JSON.stringify(data)+'\n'));
        client.on('data',chunk=>{output+=chunk.toString();if(output.length>131072)client.destroy(new Error('response too large'));});
        client.on('error',reject);client.on('end',()=>{try{resolve(JSON.parse(output));}catch{reject(new Error('invalid response'));}});
      });reply(200,result);
    }catch{reply(503,{error:'Bot indisponível. Tente novamente em instantes'});}finally{if(ownsOperation)active=false;}
  };
}
function page(nonce:string,resenha=false){return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MLG Bot — acesso privado</title><style nonce="${nonce}">body{font:17px system-ui;background:#10151d;color:#f8fafc;max-width:520px;margin:30px auto;padding:20px}input,select,textarea,button{box-sizing:border-box;width:100%;padding:14px;margin:8px 0;border-radius:8px;font:inherit}button{background:#ffcf40;color:#111;border:0}pre{white-space:pre-wrap;overflow-wrap:anywhere}label{display:block;margin-top:15px}</style><h1>🏆 MLG Bot</h1><p>Acesso privado. Não compartilhe sua senha nem o código de vinculação.</p><label>Senha do painel<input id="password" type="password" autocomplete="off"></label><button id="status">Entrar / verificar conexão</button><section id="setup" hidden><label>Número do bot com DDI e DDD<input id="phone" type="tel" autocomplete="off" placeholder="Somente números"></label><button id="pair">Gerar código de vinculação</button><p>No WhatsApp do bot: Aparelhos conectados → Conectar aparelho → Conectar com número.</p><button id="groups">Carregar grupos após conectar</button><label>Grupo<select id="group"></select></label><button id="participants">Carregar participantes</button><label>Seu usuário administrador<select id="admin"></select></label><label ${resenha?'hidden':''}>Clubes (mínimo 16, um por linha)<textarea id="clubs" rows="6"></textarea></label><button id="authorize">Autorizar grupo e cadastrar administrador</button><button id="exit">Sair e limpar</button></section><pre id="result" role="status"></pre><script nonce="${nonce}">
const el=id=>document.getElementById(id);let clearCode;
async function run(action){el('result').textContent='Aguarde…';const data={action};if(action==='pair')data.phone=el('phone').value.replace(/\\D/g,'');if(['participants','authorize'].includes(action))data.group=el('group').value;if(action==='authorize'){data.admin=el('admin').value;data.clubs=el('clubs').value.split('\\n').map(v=>v.trim()).filter(Boolean);if(!confirm('Cadastrar o participante selecionado como administrador deste grupo?'))return;}
try{const r=await fetch('/control',{method:'POST',headers:{'Content-Type':'application/json','X-MLG-Control':'1','Authorization':'Bearer '+el('password').value},body:JSON.stringify(data),cache:'no-store'});const d=await r.json();if(r.ok&&!d.error)el('setup').hidden=false;if(d.groups){el('group').replaceChildren(...d.groups.map(g=>new Option(g.name,g.id)));}if(d.participants){el('admin').replaceChildren(...d.participants.map(p=>new Option(p.phone||p.id,p.id)));}el('result').textContent=d.error||(d.code?'Código privado: '+d.code:(d.phase|| (d.authorized?'Grupo autorizado! No WhatsApp, envie ${resenha?'!resenha':'!novacopa'}.':'Lista carregada. Confira a seleção.')));if(d.code){clearTimeout(clearCode);clearCode=setTimeout(()=>{el('result').textContent='Código ocultado. Verifique a conexão.';},60000);}}catch{el('result').textContent='Não foi possível conectar. Abra esta página novamente em um minuto.';}}
for(const action of ['status','pair','groups','participants','authorize'])el(action).onclick=()=>run(action);el('exit').onclick=()=>{el('password').value='';el('phone').value='';el('result').textContent='';el('setup').hidden=true;el('group').replaceChildren();el('admin').replaceChildren();clearTimeout(clearCode);};document.addEventListener('visibilitychange',()=>{if(document.hidden)el('result').textContent='';});
</script></html>`;}
