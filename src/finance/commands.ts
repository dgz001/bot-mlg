import {money} from './money.ts';
export type FinanceCommand=
 | {type:'help'|'status'|'balance'}
 | {type:'statement'|'debts'|'report';page:number;season?:string}
 | {type:'prepare';season:string}
 | {type:'mode';mode:'off'|'bank'|'peer'|'both';season:string}
 | {type:'rules';maxLoan:number;maxDebt:number;maxDays:number;maxActive:number;approval:'manual'|'auto'}
 | {type:'credit';bank:boolean;amount:number;reason:string}
 | {type:'eligibility';eligible:boolean;reason:string}
 | {type:'request'|'offer';amount:number;days:number}
 | {type:'accept'|'reject'|'cancel'|'approve';code:string}
 | {type:'pay';code:string;amount:number}
 | {type:'administration';group:string}
 | {type:'limits';maxLoan:number;maxDebt:number;maxActive:number}
 | {type:'alerts';emission:number;utilization:number}
 | {type:'transfer';amount:number;reason:string}
 | {type:'ranking';page:number}
 | {type:'close';season:string};
export const financeHelp=`💰 FINANCEIRO · SALDO VIRTUAL
!banco pedir VALOR DIAS — solicitar ao banco.
!emprestardinheiro @pessoa VALOR DIAS — oferecer seu saldo à pessoa marcada.
!sim CÓDIGO — aceitar a proposta indicada; !nao CÓDIGO — recusar.
!financeiro cancelar CÓDIGO — cancelar uma proposta antes da transferência.
!financeiro pagar CÓDIGO VALOR — devolver parte ou todo o saldo emprestado.
!financeiro saldo · !financeiro dividas · !financeiro extrato [página]
Cada empréstimo tem código próprio. Não confirme valor diferente do combinado.
Sem juros ou multas automáticas. Não transfere dinheiro real.
ADM: !financeiro preparar TEMPORADA; !financeiro ativar banco|pessoas|ambos TEMPORADA;
!financeiro regras LIMITE_EMPRESTIMO LIMITE_DIVIDA DIAS_MAXIMOS EMPRESTIMOS_MAXIMOS manual|automatico;
!financeiro creditar banco VALOR motivo ou !financeiro creditar @pessoa VALOR motivo;
!financeiro aprovar CÓDIGO; !financeiro bloquear @pessoa motivo; !financeiro liberar @pessoa motivo;
!adicionarsaldo VALOR — abastecer o banco (ADM).
!financeiro limite @pessoa LIMITE_EMPRESTIMO LIMITE_DIVIDA QUANTIDADE — limites individuais (ADM).
!financeiro administracao ID_DO_GRUPO — destino privado da cobrança administrativa (ADM).
!financeiro alertas EMISSAO_DIARIA PERCENTUAL_BANCO — sinais de risco (ADM).
!financeiro transferir @pessoa VALOR motivo — transferir seu saldo.
!financeiro ranking [página] — comparação dos empréstimos (ADM).
!financeiro relatorio [página]; !financeiro encerrar TEMPORADA.`;
export function financeCommand(text:string):FinanceCommand|null {
 const normalized=text.trim().replace(/^!adicionarsaldo\s+(\S+)$/i,'!financeiro creditar banco $1 Abastecimento autorizado pelo ADM').replace(/^!não(?=\s|$)/i,'!nao');
 if(!/^!(?:financeiro|banco|emprestardinheiro|sim|nao)(?:\s|$)/i.test(normalized))return null;
 // !sim/!nao belong here only with our F-prefixed proposal code.
 if(/^!(sim|nao)\b/i.test(normalized)&&!/^!(sim|nao)\s+F[A-Z0-9]{10}$/i.test(normalized))return null;
 const args=normalized.split(/\s+/),head=args.shift()!.toLowerCase();
 const code=(value:string|undefined)=>{if(!value||!/^F[A-Z0-9]{10}$/i.test(value))throw Error('Informe o código financeiro completo, começando com F.');return value.toUpperCase();};
 const integer=(value:string|undefined,max:number)=>{if(!value||!/^\d+$/.test(value)||Number(value)<1||Number(value)>max)throw Error('Número fora do intervalo permitido.');return Number(value);};
 const season=(value:string|undefined)=>{if(!value||!/^[a-zA-Z0-9_-]{2,40}$/.test(value))throw Error('Use uma identificação de temporada de 2 a 40 letras, números, _ ou -.');return value;};
 const reason=(values:string[])=>{const value=values.join(' ');if(value.length<8||value.length>160||/[\x00-\x1f\x7f]/.test(value))throw Error('Informe um motivo de 8 a 160 caracteres.');return value;};
 if(head==='!sim'||head==='!nao')return {type:head==='!sim'?'accept':'reject',code:code(args[0])};
 if(head==='!emprestardinheiro'){
  if(args.length!==3||!args[0]!.startsWith('@'))throw Error('Use !emprestardinheiro @pessoa VALOR DIAS, com uma menção real.');
  return {type:'offer',amount:money(args[1]!),days:integer(args[2],365)};
 }
 if(head==='!banco'){
  if(args.length!==3||args[0]?.toLowerCase()!=='pedir')throw Error('Use !banco pedir VALOR DIAS.');
  return {type:'request',amount:money(args[1]!),days:integer(args[2],365)};
 }
 const verb=args.shift()?.toLowerCase()??'ajuda';
 if(['ajuda','status','saldo'].includes(verb)&&!args.length)return {type:verb==='ajuda'?'help':verb==='saldo'?'balance':'status'};
 if(['extrato','dividas','dívidas','relatorio','relatório'].includes(verb)&&args[0]==='temporada'&&(args.length===2||args.length===3))return {type:verb==='extrato'?'statement':verb.startsWith('div')||verb.startsWith('dív')?'debts':'report',season:season(args[1]),page:args[2]?integer(args[2],10000):1};
 if(['extrato','dividas','dívidas','relatorio','relatório'].includes(verb)&&args.length<=1)return {type:verb==='extrato'?'statement':verb.startsWith('div')||verb.startsWith('dív')?'debts':'report',page:args[0]?integer(args[0],10000):1};
 if(verb==='administracao'&&args.length===1&&/^\d[\d-]*@g\.us$/.test(args[0]!))return {type:'administration',group:args[0]!};
 if(verb==='limite'&&args.length===4&&args[0]!.startsWith('@'))return {type:'limits',maxLoan:money(args[1]!),maxDebt:money(args[2]!),maxActive:integer(args[3],100)};
 if(verb==='alertas'&&args.length===2)return {type:'alerts',emission:money(args[0]!),utilization:integer(args[1],100)};
 if(verb==='transferir'&&args.length>=3&&args[0]!.startsWith('@'))return {type:'transfer',amount:money(args[1]!),reason:reason(args.slice(2))};
 if(verb==='ranking'&&args.length<=1)return {type:'ranking',page:args[0]?integer(args[0],10000):1};
 if(verb==='preparar'&&args.length===1)return {type:'prepare',season:season(args[0])};
 if(verb==='encerrar'&&args.length===1)return {type:'close',season:season(args[0])};
 if((verb==='ativar'||verb==='pausar')&&args.length===(verb==='pausar'?1:2)){
  const mode=verb==='pausar'?'off':({banco:'bank',pessoas:'peer',ambos:'both'} as const)[args[0] as 'banco'|'pessoas'|'ambos'];
  if(!mode)throw Error('Escolha banco, pessoas ou ambos.');
  return {type:'mode',mode,season:season(args[verb==='pausar'?0:1])};
 }
 if(verb==='regras'&&args.length===5){
  if(!['manual','automatico','automático'].includes(args[4]!))throw Error('Escolha manual ou automatico.');
  return {type:'rules',maxLoan:money(args[0]!),maxDebt:money(args[1]!),maxDays:integer(args[2],365),maxActive:integer(args[3],100),approval:args[4]==='manual'?'manual':'auto'};
 }
 if(verb==='creditar'&&args.length>=3)return {type:'credit',bank:args[0]==='banco',amount:money(args[1]!),reason:reason(args.slice(2))};
 if((verb==='bloquear'||verb==='liberar')&&args.length>=2&&args[0]?.startsWith('@'))return {type:'eligibility',eligible:verb==='liberar',reason:reason(args.slice(1))};
 if(['aprovar','cancelar'].includes(verb)&&args.length===1)return {type:verb==='aprovar'?'approve':'cancel',code:code(args[0])};
 if(verb==='pagar'&&args.length===2)return {type:'pay',code:code(args[0]),amount:money(args[1]!)};
 throw Error('Comando financeiro inválido. Use !financeiro ajuda.');
}
export function financialText(text:string):boolean {
 return /^!(?:financeiro|banco|emprestardinheiro|adicionarsaldo)(?:\s|$)/i.test(text.trim())||/^!(?:sim|nao|não)\s+F[A-Z0-9]{10}$/i.test(text.trim());
}
