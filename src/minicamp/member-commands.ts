import {memberName} from './member-name.ts';

// The selected WhatsApp JID is supplied separately from the visible @token.
// WhatsApp may render that token as a phone/JID; never use it as the display name.
export function memberCommand(text:string,targetId:string):string {
 const [command='']=text.trim().split(/\s+/,1);
 const cmd=command.toLowerCase(),tail=text.trim().slice(command.length).trim();
 if(!['!cadastrar','!editar','!excluir','!registrar','!associar'].includes(cmd))throw Error('Comando inválido.');
 if(!targetId||/\s/.test(targetId))throw Error('Conta marcada inválida.');

 const separator=tail.indexOf('|');
 const before=separator<0?tail:tail.slice(0,separator).trim();
 const after=separator<0?'':tail.slice(separator+1).trim();
 const isMentionToken=(value:string)=>/^@[^\s|]+$/.test(value);

 if(cmd==='!excluir') {
  if(!isMentionToken(tail))throw Error('Formato: !excluir @conta.');
  return '!excluirid '+targetId;
 }
 if(cmd==='!cadastrar'||cmd==='!editar') {
  if(separator<0||!isMentionToken(before)||!after) {
   throw Error('Formato: '+cmd+' @conta | Nome completo.');
  }
  return cmd+'id '+targetId+' '+memberName(after);
 }
 if(separator<0||!isMentionToken(after)) {
  throw Error('Formato: '+cmd+' Nome completo | @conta.');
 }
 return cmd+'id '+targetId+' '+memberName(before);
}
