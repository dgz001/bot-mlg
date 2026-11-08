import {parseWhatsAppMarketProposal,type WhatsAppMarketProposal} from './market-proposal.ts';
import type {MarketResponse} from './market-response.ts';

export const MAX_MARKET_PROPOSALS=100;
export const MAX_MARKET_RESPONSES=200;
const MAX_BATCH=20;
const MAX_RETRY_MS=15*60_000;
const INITIAL_RETRY_MS=15_000;

export type MarketEvent={
 group:string;messageId:string;participant:string;text:string;queuedAt?:number;
 mentions?:string[];cardReading?:{week:string|null;confidence:number;text:string;imageHash:string};
 parsed:WhatsAppMarketProposal;attempts?:number;retryAt?:number;terminalReason?:'batch_closed'
};
export type QueuedMarketResponse=MarketResponse&{attempts?:number;retryAt?:number};
export type MarketQueueResult='queued'|'duplicate'|'full';
export type MarketChannel={kind:'transfer'|'trade';group:string};
export type MarketReaction={id:string;revision:number;emoji:''|'🟠'|'🟢'|'🔴';lease:string;group:string;messageId:string;participant:string};
export type MarketApi=ReturnType<typeof marketBridge>;

type MarketQueueState={marketInbox?:MarketEvent[];marketResponses?:QueuedMarketResponse[]};

export function enqueueMarketEvent(state:MarketQueueState,event:MarketEvent):MarketQueueResult{
 state.marketInbox??=[];
 if(state.marketInbox.some(e=>e.group===event.group&&e.messageId===event.messageId&&e.text===event.text))return 'duplicate';
 if(state.marketInbox.length>=MAX_MARKET_PROPOSALS)return 'full';
 state.marketInbox.push(event);return 'queued';
}
export function enqueueMarketResponse(state:MarketQueueState,response:QueuedMarketResponse):MarketQueueResult{
 state.marketResponses??=[];
 if(state.marketResponses.some(e=>e.group===response.group&&e.messageId===response.messageId))return 'duplicate';
 if(state.marketResponses.length>=MAX_MARKET_RESPONSES)return 'full';
 state.marketResponses.push(response);return 'queued';
}
export function marketEvent(group:string,messageId:string,participant:string,text:string,channels:MarketChannel[]):MarketEvent|null{
 const channel=channels.find(c=>c.group===group);if(!channel||text.length>16000)return null;
 const parsed=parseWhatsAppMarketProposal(text);if(!parsed)return null;
 if(parsed.kind!==channel.kind)parsed.issues.push('Modelo de proposta diferente do grupo configurado.');
 return {group,messageId,participant,text,queuedAt:Date.now(),parsed:{...parsed,kind:channel.kind}};
}
export function canRecoverMarketMessage(type:string,group:string,timestampSeconds:unknown,captureSince:number,channels:MarketChannel[],now=Date.now()){
 if(type==='notify')return true;
 const at=Number(timestampSeconds)*1000;
 return type==='append'&&channels.some(c=>c.group===group)&&Number.isSafeInteger(at)&&captureSince>0&&at>=captureSince&&at<=now+60000;
}
export function marketHealthPayload(state:{marketInbox?:MarketEvent[];marketResponses?:{at:number}[]},options:{phase:string;enabled:boolean;healthy:boolean;blocked:boolean;groups:string[];now?:number}){
 const now=options.now??Date.now(),times=[...(state.marketInbox??[]).map(e=>e.queuedAt??now),...(state.marketResponses??[]).map(e=>e.at)].filter(Number.isFinite);
 return {phase:options.phase,enabled:options.enabled,healthy:options.healthy,blocked:options.blocked,groups:options.groups,proposalQueue:state.marketInbox?.length??0,responseQueue:state.marketResponses?.length??0,oldestAgeSeconds:Math.min(315360000,Math.max(0,Math.floor((now-(times.length?Math.min(...times):now))/1000)))};
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
function retryDelay(attempts:number){return Math.min(MAX_RETRY_MS,INITIAL_RETRY_MS*2**Math.min(10,Math.max(0,attempts-1)));}
async function removeProposal(state:MarketQueueState,event:MarketEvent,save:()=>Promise<void>){
 const previous=state.marketInbox;state.marketInbox=previous?.filter(e=>e!==event);
 try{await save();}catch(error){state.marketInbox=previous;throw error;}
}
async function removeResponse(state:MarketQueueState,response:QueuedMarketResponse,save:()=>Promise<void>){
 const previous=state.marketResponses;state.marketResponses=previous?.filter(e=>e!==response);
 try{await save();}catch(error){state.marketResponses=previous;throw error;}
}
async function deferProposal(event:MarketEvent,save:()=>Promise<void>,now:number){
 const attempts=(event.attempts??0)+1,previous={attempts:event.attempts,retryAt:event.retryAt};
 event.attempts=attempts;event.retryAt=now+retryDelay(attempts);
 try{await save();}catch(error){event.attempts=previous.attempts;event.retryAt=previous.retryAt;throw error;}
}
async function deferResponse(response:QueuedMarketResponse,save:()=>Promise<void>,now:number){
 const attempts=(response.attempts??0)+1,previous={attempts:response.attempts,retryAt:response.retryAt};
 response.attempts=attempts;response.retryAt=now+retryDelay(attempts);
 try{await save();}catch(error){response.attempts=previous.attempts;response.retryAt=previous.retryAt;throw error;}
}
export async function drainMarketInbox(
 state:MarketQueueState,api:MarketApi,save:()=>Promise<void>,
 onBatchClosed:(event:MarketEvent)=>Promise<boolean>,
 now=Date.now(),onRetry?:(event:MarketEvent,error:unknown)=>void
){
 const eligible=(state.marketInbox??[]).filter(e=>(e.retryAt??0)<=now).slice(0,MAX_BATCH);
 for(const event of eligible){
  try{
   if(event.terminalReason==='batch_closed'){
    if(await onBatchClosed(event))await removeProposal(state,event,save);
    else await deferProposal(event,save,now);
    continue;
   }
   const {attempts,retryAt,terminalReason,...payload}=event;
   const result=await api<{success:boolean;reason?:string}>('ingest',payload);
   if(result.success!==true&&result.reason==='batch_closed'){
    const previous=event.terminalReason;event.terminalReason='batch_closed';
    try{await save();}catch(error){event.terminalReason=previous;throw error;}
    if(await onBatchClosed(event))await removeProposal(state,event,save);
    else await deferProposal(event,save,now);
    continue;
   }
   if(result.success!==true)throw Error('Market proposal not confirmed');
   await removeProposal(state,event,save);
  }catch(error){
   await deferProposal(event,save,now);
   try{onRetry?.(event,error);}catch{}
  }
 }
}
export async function drainMarketResponses(
 state:MarketQueueState,api:MarketApi,save:()=>Promise<void>,
 now=Date.now(),onRetry?:(response:QueuedMarketResponse,error:unknown)=>void
){
 const eligible=(state.marketResponses??[]).filter(e=>(e.retryAt??0)<=now).slice(0,MAX_BATCH);
 for(const response of eligible){
  try{
   const {attempts,retryAt,...payload}=response;
   const result=await api<{success:boolean}>('response',payload);
   if(result.success!==true)throw Error('Response not confirmed');
   await removeResponse(state,response,save);
  }catch(error){
   await deferResponse(response,save,now);
   try{onRetry?.(response,error);}catch{}
  }
 }
}
export async function deliverMarketReactions(api:MarketApi,send:(reaction:MarketReaction)=>Promise<void>,alive:()=>boolean){
 const {reactions}=await api<{reactions:MarketReaction[]}>('claim_reactions');
 if(!Array.isArray(reactions))throw Error('Invalid reaction list');
 for(const reaction of reactions){let sent=false;
  if(alive())try{await send(reaction);sent=true;}catch{}
  await api('ack_reaction',{id:reaction.id,revision:reaction.revision,emoji:reaction.emoji,lease:reaction.lease,sent});
 }
}
