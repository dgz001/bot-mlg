import {createHash} from 'node:crypto';
import type {GroupMode} from './group-modes.ts';

export function adminAuditTargets(groups:string[],modes:Record<string,GroupMode>|undefined,loanGroups:string[]|undefined):string[]{
 return [...new Set(groups.filter(group=>modes?.[group]==='controle'&&!loanGroups?.includes(group)))].sort();
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

export function marketWindowCommandDelivery(eventType:string,text:string):'execute'|'retry'|'ignore'{
 if(!isMarketWindowCommand(text))return 'ignore';
 if(eventType==='notify')return 'execute';
 if(eventType==='append')return 'retry';
 return 'ignore';
}
