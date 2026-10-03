import {parseWhatsAppMarketProposal,type WhatsAppMarketProposal} from './market-proposal.ts';
export type MarketEvent={group:string;messageId:string;participant:string;text:string;mentions?:string[];cardReading?:{week:string|null;confidence:number;text:string;imageHash:string};parsed:WhatsAppMarketProposal};
export type MarketChannel={kind:'transfer'|'trade';group:string};
export type MarketReaction={id:string;revision:number;emoji:'🟠'|'🟢'|'🔴';lease:string;group:string;messageId:string;participant:string};
export function marketEvent(group:string,messageId:string,participant:string,text:string,channels:MarketChannel[]):MarketEvent|null{
 const channel=channels.find(c=>c.group===group);if(!channel)return null;
 const parsed=parseWhatsAppMarketProposal(text);if(!parsed)return null;
 if(parsed.kind!==channel.kind)parsed.issues.push('Modelo de proposta diferente do grupo configurado.');
 return {group,messageId,participant,text,parsed:{...parsed,kind:channel.kind}};
}
export function marketBridge(url:string,key:string,token:string,fetcher:typeof fetch=fetch){
 const source=new URL(url);
 if(source.protocol!=='https:'||!/^([a-z0-9-]+)\.supabase\.co$/.test(source.hostname)||!key||!/^[a-f0-9]{64}$/.test(token))throw Error('Invalid market bridge configuration');
 return async<T=Record<string,unknown>>(action:string,payload:unknown={}):Promise<T>=>{
  const response=await fetcher(new URL('/rest/v1/rpc/bot_whatsapp_market_gate',source),{method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({p_token:token,p_action:action,p_payload:payload}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('Market bridge unavailable');
  const value=await response.json();if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid market bridge response');return value as T;
 };
}
export async function drainMarketInbox(state:{marketInbox?:MarketEvent[]},api:ReturnType<typeof marketBridge>,save:()=>Promise<void>){
 for(const event of [...(state.marketInbox??[])].slice(0,20)){
  const result=await api<{success:boolean}>('ingest',event);
  if(result.success!==true)throw Error('Market proposal not confirmed');
  const previous=state.marketInbox;state.marketInbox=state.marketInbox?.filter(e=>!(e.group===event.group&&e.messageId===event.messageId&&e.text===event.text));
  try{await save();}catch(error){state.marketInbox=previous;throw error;}
 }
}
export async function deliverMarketReactions(api:ReturnType<typeof marketBridge>,send:(reaction:MarketReaction)=>Promise<void>,alive:()=>boolean){
 const {reactions}=await api<{reactions:MarketReaction[]}>('claim_reactions');
 if(!Array.isArray(reactions))throw Error('Invalid reaction list');
 for(const reaction of reactions){let sent=false;
  if(alive())try{await send(reaction);sent=true;}catch{}
  await api('ack_reaction',{id:reaction.id,revision:reaction.revision,emoji:reaction.emoji,lease:reaction.lease,sent});
 }
}
