import {defaultControls,type BotControls} from './bot-controls.ts';

export function whatsappControls(command:string,current:BotControls|undefined):{text:string;next?:BotControls;restart?:boolean}|null{
 const cmd=command.trim().toLocaleLowerCase('pt-BR');
 const state={...defaultControls,...current};
 const summary=()=>`🎛️ BOT MLG\n${state.enabled?'🟢 Ligado':'🔴 Respostas pausadas'}\n🏆 Copas: ${state.minicamp?'ativas':'pausadas'}\n🍿 Resenha: ${state.resenha?'ativa':'pausada'}\n\n!acordarbot · !desligarbot · !reiniciarbot\n!copas ligar/desligar · !resenha ligar/desligar`;
 if(cmd==='!modulos'||cmd==='!statusbot')return {text:summary()};
 if(cmd==='!acordarbot'||cmd==='!ligarbot')return {next:{...state,enabled:true,minicamp:true},text:'🟢 Bot ligado. Comandos da Copa liberados; mensagens pendentes voltam a ser processadas.\n'+(state.resenha?'Resenha ativa.':'Resenha continua pausada; use !resenha ligar para ativá-la.')};
 if(cmd==='!desligarbot')return {next:{...state,enabled:false},text:'🔴 Respostas do bot pausadas. A Copa, a sessão e a fila continuam salvas.\nA central permanece acessível: use !acordarbot quando quiser voltar.'};
 if(cmd==='!reiniciarbot')return {restart:true,text:'🔄 Reinício solicitado. A conexão pode cair por alguns segundos; a Copa e o estado ligado/desligado ficam salvos. Use !statusbot após a reconexão.'};
 const m=/^!(copas|resenha) (ligar|desligar)$/.exec(cmd);
 if(!m)return null;
 const module=m[1]==='copas'?'minicamp':'resenha';const next={...state,[module]:m[2]==='ligar'};
 return {next,text:(next[module]?'✅ ':'⏸️ ')+(module==='minicamp'?'Copas':'Resenha')+(next[module]?' ativadas.':' pausada.')+(next.enabled?'':' O bot ainda está desligado; use !acordarbot para liberar respostas.')};
}
