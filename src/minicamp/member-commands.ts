import {memberName} from './member-name.ts';

// The target ID comes from WhatsApp's verified mention metadata, never the @text.
export function memberCommand(text:string,targetId:string):string {
 const [command='']=text.trim().split(/\s+/,1);
 const cmd=command.toLowerCase(),tail=text.trim().slice(command.length).trim();
 if(!['!cadastrar','!editar','!excluir','!registrar','!associar'].includes(cmd))throw Error('Comando inválido.');
 if(!targetId||/\s/.test(targetId))throw Error('Conta marcada inválida.');
 if(cmd==='!excluir')return '!excluirid '+targetId;
 if((cmd==='!registrar'||cmd==='!associar')&&!tail.includes('|'))throw Error('Marque a conta após |.');
 const name=cmd==='!editar'?tail.split('|')[1]:cmd==='!cadastrar'?(tail.split('|')[1]??tail):tail.split('|')[0];
 return `${cmd}id ${targetId} ${memberName(name??'')}`;
}
