import type {WAMessageKey} from '@whiskeysockets/baileys';

type Messenger={sendMessage:(jid:string,content:{text:string;edit?:WAMessageKey})=>Promise<{key:WAMessageKey}|undefined>};

// The short delay keeps quick commands to a single message. The placeholder is
// never a confirmation; callers must finish with the actual command outcome.
export function progressMessage(socket:Messenger,group:string,active:()=>boolean,delayMs=900){
 let started=false,loading:Promise<{key:WAMessageKey}|undefined>|undefined;
 const timer=setTimeout(()=>{
  if(active())loading=socket.sendMessage(group,{text:'⏳ Processando seu comando…'}).catch(()=>undefined);
 },delayMs);
 return async (answer:string)=>{
  if(started)return;
  started=true;
  clearTimeout(timer);
  if(!active())return;
  const placeholder=await loading;
  if(!active())return;
  if(placeholder?.key.id){
   try{await socket.sendMessage(group,{text:answer,edit:placeholder.key});return;}
   catch{/* An edit may be unavailable on some WhatsApp clients. */}
  }
  await socket.sendMessage(group,{text:answer});
 };
}
