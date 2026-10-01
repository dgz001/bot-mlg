import {financialText} from './commands.ts';
export {financialText};
export const financeDisabled='💰 O financeiro está em preparação para a próxima temporada. Nenhuma proposta, dívida ou transferência foi registrada. !emprestar telefone continua sendo o empréstimo do bot.';
export function financeClient(url:string,token:string){
 return async<T=Record<string,unknown>>(body:unknown):Promise<T>=>{
  const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw Error('Financial service unavailable');return response.json() as Promise<T>;
 };
}
