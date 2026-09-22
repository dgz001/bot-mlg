export type PendingCupEvent={group:string;aliases:string[];targets?:string[][];id:string;name:string;text:string};
export function minicampCommand(text:string):boolean {
 return /^(?:![a-zç]+(?:\s|$)|[123]$)/i.test(text)&&/^(?:!(?:clubes|comandos|confronto|forcarresultado|forcar|forçar|cancelarcopa|config|novacopa|formato|entrar|resultado|confirmar|contestar|resolver|cancelar|copa|jogo|historico|minhascopas|campeoes|ranking|stats|ajuda|minicamp)(?:\s|$)|[123]$)/i.test(text);
}
export function minicampClient(url:string,token:string){
 return async function call<T=Record<string,unknown>>(body:unknown):Promise<T>{
  const r=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
  if(!r.ok)throw Error('Minicamp service unavailable');return r.json() as Promise<T>;
 };
}
