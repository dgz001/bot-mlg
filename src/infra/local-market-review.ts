import {createHash} from 'node:crypto';
import type {MarketEvent} from './platform-market.ts';

export const MAX_PENDING_LOCAL_MARKET_PROPOSALS=100;
export const MAX_ARCHIVED_LOCAL_MARKET_PROPOSALS=500;
const DEFAULT_PAGE_SIZE=15;

type LocalReviewEvent=MarketEvent&{ticketId?:string;reviewedAt?:number;reviewedBy?:string};
type LocalReviewState={marketInbox?:LocalReviewEvent[]};

export function localMarketTicketId(group:string,messageId:string):string{
 return createHash('sha256').update(group+'\0'+messageId).digest('hex').slice(0,12).toUpperCase();
}

function uniqueTicketId(event:LocalReviewEvent,used:Set<string>):string{
 const base=localMarketTicketId(event.group,event.messageId);
 if(!used.has(base))return base;
 let attempt=1;
 while(true){
  const candidate=createHash('sha256').update(event.group+'\0'+event.messageId+'\0'+attempt++).digest('hex').slice(0,12).toUpperCase();
  if(!used.has(candidate))return candidate;
 }
}

export function ensureLocalMarketTicketIds(state:LocalReviewState):void{
 state.marketInbox??=[];
 const used=new Set<string>();
 for(const event of state.marketInbox){
  if(!event.localOnly)continue;
  const current=typeof event.ticketId==='string'?event.ticketId.toUpperCase():'';
  if(current&&!used.has(current)){event.ticketId=current;used.add(current);continue;}
  const id=uniqueTicketId(event,used);event.ticketId=id;used.add(id);
 }
}

export type LocalMarketQueueResult='queued'|'duplicate'|'full';
export function enqueueLocalMarketProposal(state:LocalReviewState,event:LocalReviewEvent):LocalMarketQueueResult{
 state.marketInbox??=[];
 ensureLocalMarketTicketIds(state);
 if(state.marketInbox.some(item=>item.localOnly&&item.group===event.group&&item.messageId===event.messageId))return 'duplicate';
 const pending=state.marketInbox.filter(item=>item.localOnly&&typeof item.reviewedAt!=='number').length;
 if(pending>=MAX_PENDING_LOCAL_MARKET_PROPOSALS)return 'full';
 event.localOnly=true;
 event.ticketId=uniqueTicketId(event,new Set(state.marketInbox.flatMap(item=>item.localOnly&&item.ticketId?[item.ticketId]:[])));
 state.marketInbox.push(event);return 'queued';
}

export function pendingLocalMarketProposals(state:LocalReviewState):LocalReviewEvent[]{
 ensureLocalMarketTicketIds(state);
 return (state.marketInbox??[]).filter(event=>event.localOnly&&typeof event.reviewedAt!=='number')
  .sort((a,b)=>(a.queuedAt??0)-(b.queuedAt??0));
}

export function localMarketProposalPage(state:LocalReviewState,page:number,pageSize=DEFAULT_PAGE_SIZE){
 const pending=pendingLocalMarketProposals(state);
 const safePage=Math.max(1,Math.floor(Number.isFinite(page)?page:1));
 const safeSize=Math.max(1,Math.min(50,Math.floor(Number.isFinite(pageSize)?pageSize:DEFAULT_PAGE_SIZE)));
 const pageCount=Math.max(1,Math.ceil(pending.length/safeSize));
 const start=(safePage-1)*safeSize;
 return {items:pending.slice(start,start+safeSize),page:safePage,pageCount,total:pending.length};
}

export type CompleteLocalMarketResult={status:'reviewed'|'already_reviewed'|'not_found';event?:LocalReviewEvent};
export function completeLocalMarketProposal(state:LocalReviewState,ticketId:string,actor:string,now=Date.now()):CompleteLocalMarketResult{
 ensureLocalMarketTicketIds(state);
 const event=(state.marketInbox??[]).find(item=>item.localOnly&&item.ticketId===ticketId.trim().toUpperCase());
 if(!event)return {status:'not_found'};
 if(typeof event.reviewedAt==='number')return {status:'already_reviewed',event};
 event.reviewedAt=now;
 event.reviewedBy=actor.slice(0,120);
 const archived=(state.marketInbox??[]).filter(item=>item.localOnly&&typeof item.reviewedAt==='number')
  .sort((a,b)=>(a.reviewedAt??0)-(b.reviewedAt??0));
 const excess=archived.length-MAX_ARCHIVED_LOCAL_MARKET_PROPOSALS;
 if(excess>0){
  const remove=new Set(archived.slice(0,excess));
  state.marketInbox=state.marketInbox?.filter(item=>!remove.has(item));
 }
 return {status:'reviewed',event};
}

export type LocalMarketReviewCommand={action:'list';page:number}|{action:'complete';ticketId:string};
export function parseLocalMarketReviewCommand(text:string):LocalMarketReviewCommand|null{
 const value=text.trim();
 const list=value.match(/^!propostas(?:\s+([1-9]\d?))?$/i);
 if(list)return {action:'list',page:Number(list[1]??1)};
 const complete=value.match(/^!proposta\s+concluir\s+([a-f0-9]{12})$/i);
 if(complete)return {action:'complete',ticketId:complete[1]!.toUpperCase()};
 return null;
}
