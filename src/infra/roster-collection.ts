import {createHash} from 'node:crypto';
export type RosterConfig={enabled:boolean;group:string|null;run:string|null;opened:boolean;directory:{id:string;name:string;recipient:string}[]};
export type RosterEntry={club:string;name:string;recipient:string;requested?:boolean;text?:string;image?:any;seen:string[];photoSent?:boolean;textSent?:boolean;delivered?:boolean;progress?:string};
export type RosterState={run:string;group:string;entries:RosterEntry[];summary?:string};
export function rosterTextReady(text:string){
 const lines=text.split(/\r?\n/).map(l=>l.replace(/^[\s\d.*)\-]+/,'').trim()).filter(Boolean);let goal=false,count=0;
 for(const l of lines){if(/goleir/i.test(l)){goal=true;continue;}if(/defens|zagueir|latera|meio|volante|atac|defesa|ataque|técnico|tecnico/i.test(l)){goal=false;continue;}if(goal&&/[\p{L}]/u.test(l)&&!/^elenco/i.test(l))count++;}
 return count>=2&&lines.length>=13;
}
export function rosterMessageId(run:string,club:string,part:string){return 'MLGROSTER'+createHash('sha256').update(JSON.stringify([run,club,part])).digest('hex').slice(0,24).toUpperCase();}
export function rosterSummary(state:RosterState){const names=(f:(e:RosterEntry)=>boolean)=>state.entries.filter(f).map(e=>e.name).join(', ')||'Nenhum';return '📋 Elencos finais — '+state.entries.filter(e=>e.delivered).length+'/'+state.entries.length+' entregues\n✅ Entregues: '+names(e=>!!e.delivered)+'\n🟠 Incompletos: '+names(e=>!e.delivered&&!!(e.text||e.image))+'\n⏳ Aguardando: '+names(e=>!e.delivered&&!e.text&&!e.image)+'\nEntrega não significa aprovação do elenco na plataforma.';}
export async function rosterTick(holder:{rosterCollection?:RosterState},config:RosterConfig,save:()=>Promise<void>,send:(recipient:string,text:string,id:string)=>Promise<void>,photo:(entry:RosterEntry,group:string,id:string)=>Promise<void>,progress:(entry:RosterEntry,status:string)=>Promise<void>,adminGroups:string[]){
 if(!config.enabled||!config.group||!config.run||config.opened||config.directory.length!==25)return;
 if(holder.rosterCollection?.run!==config.run){holder.rosterCollection={run:config.run,group:config.group,entries:config.directory.map(c=>({club:c.id,name:c.name,recipient:c.recipient,seen:[]}))};await save();}
 const state=holder.rosterCollection;if(state.group!==config.group){state.group=config.group;for(const e of state.entries)if(!e.delivered){e.photoSent=false;e.textSent=false;}await save();}
 let failed=false;
 for(const e of state.entries){try{
  if(!e.requested){await send(e.recipient,'📋 '+e.name+': a janela encerrou. Envie aqui a foto do elenco e a lista completa atualizada, organizada por posições, com pelo menos dois goleiros. Pode enviar foto e texto separadamente.',rosterMessageId(state.run,e.club,'request'));e.requested=true;await save();}
  if(!e.delivered&&e.image&&e.text&&rosterTextReady(e.text)){
   if(e.progress!=='ready'){await progress(e,'ready');e.progress='ready';await save();}
   if(!e.photoSent){await photo(e,state.group,rosterMessageId(state.run,e.club,'photo'));e.photoSent=true;await save();}
   if(!e.textSent){await send(state.group,'📋 '+e.name+' — elenco final recebido do responsável\n\n'+e.text,rosterMessageId(state.run,e.club,'text'));e.textSent=true;await save();}
   e.delivered=true;await save();
  }
  const status=e.delivered?'delivered':e.image&&e.text&&rosterTextReady(e.text)?'ready':e.image||e.text?'incomplete':'requested';
  if(e.progress!==status){await progress(e,status);e.progress=status;await save();}
 }catch{failed=true;}}
 const summary=rosterSummary(state);if(state.summary!==summary){for(const group of adminGroups)await send(group,summary,rosterMessageId(state.run,group,createHash('sha256').update(summary).digest('hex')));if(adminGroups.length){state.summary=summary;await save();}}
 if(failed)throw Error('Roster deliveries awaiting retry');
}
