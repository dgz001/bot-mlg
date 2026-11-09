import {createHash} from 'node:crypto';
import type {GroupMode} from './group-modes.ts';

export function adminAuditTargets(groups:string[],modes:Record<string,GroupMode>|undefined,loanGroups:string[]|undefined):string[]{
 return [...new Set(groups.filter(group=>modes?.[group]==='controle'&&!loanGroups?.includes(group)))].sort();
}
export function auditContent(content:unknown):string{
 if(!content||typeof content!=='object')return '[conteúdo não textual]';
 const value=content as Record<string,unknown>;
 for(const key of ['text','caption'])if(typeof value[key]==='string'&&(value[key] as string).trim())return (value[key] as string).trim().slice(0,700);
 if(value.react&&typeof value.react==='object'){
  const reaction=(value.react as Record<string,unknown>).text;
  return 'Reação enviada: '+(typeof reaction==='string'?reaction:'(não identificada)');
 }
 if(value.image)return '[imagem enviada]';
 if(value.video)return '[vídeo enviado]';
 if(value.document)return '[documento enviado]';
 return '[ação WhatsApp: '+Object.keys(value).slice(0,8).join(', ')+']';
}
export function auditMessageId(messageId:string,group:string):string{
 return 'MLGAUDIT'+createHash('sha256').update(JSON.stringify([messageId,group])).digest('hex').slice(0,24).toUpperCase();
}
export function adminAuditBody(input:{at:number;destination:string;messageId:string;content:unknown}):string{
 return ['🧾 REGISTRO DE AÇÃO DO BOT','Horário: '+new Date(input.at).toISOString(),'Destino: '+input.destination,'ID da mensagem: '+input.messageId,'Conteúdo: '+auditContent(input.content)].join('\n');
}

export function marketWindowCommandAction(text:string):'open'|'close'|null{
 const command=text.trim().toLowerCase();
 if(command==='!transligar')return 'open';
 if(command==='!transdesligar')return 'close';
 return null;
}
export function isMarketWindowCommand(text:string):boolean{
 return marketWindowCommandAction(text)!==null;
}
