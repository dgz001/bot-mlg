export type MarketGroupBatch={group:string;count:number;limit?:number;botLocked:boolean};
// Only ADMs reopen WhatsApp. A released batch clears ownership once their
// manual reopen is observed; reconnecting must never reopen a closed group.
export async function reconcileMarketGroupGate(batch:MarketGroupBatch,announce:boolean,close:()=>Promise<void>,ack:(locked:boolean)=>Promise<void>):Promise<boolean>{
 const limit=batch.limit??10;
 if(!Number.isInteger(limit)||limit<1||!Number.isInteger(batch.count)||batch.count<0)throw Error('Invalid market batch');
 if(batch.count>=limit){
  if(!announce)await close();
  if(!batch.botLocked)await ack(true);
  return !announce;
 }
 if(batch.botLocked&&!announce)await ack(false);
 return false;
}
