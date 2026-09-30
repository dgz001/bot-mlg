export type PendingCupEvent={group:string;aliases:string[];targets?:string[][];id:string;name:string;text:string;at?:number};
// Paused channels retain their commands without blocking other channels.
export function pendingCupBatch(events:readonly PendingCupEvent[],active:(group:string)=>boolean):PendingCupEvent[]{
 return events.filter(event=>active(event.group)).slice(0,5);
}
export function minicampCommand(text:string):boolean {
 return /^(?:![a-zçíó]+(?:\s|$)|[1234]$)/i.test(text)&&/^(?:!(?:cadastrar|editar|excluir|meunome|chave|lado|jornada|arquivo|vistoria|carreira|moral|participantes|registrar|associar|sincronizarcontas|revisarnumeros|supabase|teste|titulo|título|sair|deletar|deletartitulo|anularcopa|clubes|times|selecoes|comandos|confronto|forcarresultado|forcar|forçar|cancelarcopa|config|novacopa|nome|categoria|jogos|abrircopa|formato|entrar|resultado|confirmar|contestar|resolver|cancelar|copa|sorteio|jogo|meujogo|proximafase|proxima\s+fase|próxima\s+fase|resenhacamp|historico|minhascopas|campeoes|ranking|stats|ajuda|minicamp)(?:\s|$)|[1234]$)/i.test(text);
}
export function minicampClient(url:string,token:string){
 return async function call<T=Record<string,unknown>>(body:unknown):Promise<T>{
  const r=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
  if(!r.ok)throw Error('Minicamp service unavailable');return r.json() as Promise<T>;
 };
}
