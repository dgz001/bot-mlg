import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';

const name='mlg_panel';
const lifetime=30*24*60*60*1000;
export function panelSession(secret:string){
 const key=createHash('sha256').update('mlg-panel-session-v1:').update(secret).digest();
 function issue(password:string,now=Date.now()){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  const body=Buffer.concat([cipher.update(JSON.stringify({password,expires:now+lifetime}),'utf8'),cipher.final()]);
  return `${name}=${Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url')}; Max-Age=${lifetime/1000}; Path=/; HttpOnly; Secure; SameSite=Strict`;
 }
 function read(cookie:string|undefined,now=Date.now()):string|undefined{
  const value=cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1);
  if(!value||value.length>1024)return;
  try{
   const data=Buffer.from(value,'base64url');if(data.length<29)return;
   const decipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));
   decipher.setAuthTag(data.subarray(12,28));
   const parsed=JSON.parse(Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8'));
   if(typeof parsed.password==='string'&&parsed.password.length>=32&&typeof parsed.expires==='number'&&parsed.expires>now&&parsed.expires<=now+lifetime)return parsed.password;
  }catch{return;}
 }
 return {issue,read,clear:`${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`};
}
