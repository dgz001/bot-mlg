import test from 'node:test';
import assert from 'node:assert/strict';
import type {MarketEvent} from '../src/infra/platform-market.ts';
import {MAX_ARCHIVED_LOCAL_MARKET_PROPOSALS,MAX_PENDING_LOCAL_MARKET_PROPOSALS,completeLocalMarketProposal,enqueueLocalMarketProposal,ensureLocalMarketTicketIds,localMarketProposalPage,localMarketTicketId,parseLocalMarketReviewCommand,pendingLocalMarketProposals} from '../src/infra/local-market-review.ts';

function proposal(messageId:string):MarketEvent{
 return {group:'market@g.us',messageId,participant:'123@s.whatsapp.net',text:'proposal '+messageId,queuedAt:Number(messageId)||1,localOnly:true,adminNotified:false,parsed:{kind:'transfer',purchaseScope:'internal',origin:'Aston Villa',destination:'Real Madrid',playersFrom:['Player One'],playersTo:[],amountEuros:'1000000',issues:[]}};
}

test('local review tickets are deterministic, compact and unique per WhatsApp message',()=>{
 const a=localMarketTicketId('market@g.us','message-1');
 assert.equal(a,localMarketTicketId('market@g.us','message-1'));
 assert.match(a,/^[A-F0-9]{12}$/);
 assert.notEqual(a,localMarketTicketId('market@g.us','message-2'));
 assert.notEqual(a,localMarketTicketId('other@g.us','message-1'));
});

test('local inbox deduplicates a WhatsApp message and caps unresolved proposals',()=>{
 const state:{marketInbox?:MarketEvent[]}={marketInbox:[]};
 assert.equal(enqueueLocalMarketProposal(state,proposal('1')),'queued');
 assert.equal(enqueueLocalMarketProposal(state,proposal('1')),'duplicate');
 for(let i=2;i<=MAX_PENDING_LOCAL_MARKET_PROPOSALS;i++)assert.equal(enqueueLocalMarketProposal(state,proposal(String(i))),'queued');
 assert.equal(pendingLocalMarketProposals(state).length,MAX_PENDING_LOCAL_MARKET_PROPOSALS);
 assert.equal(enqueueLocalMarketProposal(state,proposal('overflow')),'full');
 assert.equal(state.marketInbox?.length,MAX_PENDING_LOCAL_MARKET_PROPOSALS);
});

test('review completion archives the item but does not mutate the proposal or finance data',()=>{
 const item=proposal('101');
 const state:{marketInbox?:MarketEvent[]}={marketInbox:[item]};
 ensureLocalMarketTicketIds(state);
 const ticket=item.ticketId!;
 const result=completeLocalMarketProposal(state,ticket,'adm@s.whatsapp.net',1234);
 assert.equal(result.status,'reviewed');
 assert.equal(item.reviewedAt,1234);
 assert.equal(item.reviewedBy,'adm@s.whatsapp.net');
 assert.equal(pendingLocalMarketProposals(state).length,0);
 assert.equal(item.parsed.amountEuros,'1000000');
 assert.equal(item.parsed.origin,'Aston Villa');
 assert.equal(completeLocalMarketProposal(state,ticket,'another-adm',2000).status,'already_reviewed');
});

test('completed history is bounded while pending proposals are never pruned',()=>{
 const state:{marketInbox?:MarketEvent[]}={marketInbox:[]};
 for(let i=1;i<=MAX_ARCHIVED_LOCAL_MARKET_PROPOSALS+10;i++){
  const item=proposal('archive-'+i);
  assert.equal(enqueueLocalMarketProposal(state,item),'queued');
  assert.equal(completeLocalMarketProposal(state,item.ticketId!,'adm',i).status,'reviewed');
 }
 const pending=proposal('still-pending');
 assert.equal(enqueueLocalMarketProposal(state,pending),'queued');
 const archived=state.marketInbox!.filter(item=>item.localOnly&&typeof item.reviewedAt==='number');
 assert.equal(archived.length,MAX_ARCHIVED_LOCAL_MARKET_PROPOSALS);
 assert.equal(pendingLocalMarketProposals(state).length,1);
 assert.ok(state.marketInbox!.some(item=>item.messageId==='still-pending'));
});

test('ADM review commands parse exact list, pagination and completion forms only',()=>{
 assert.deepEqual(parseLocalMarketReviewCommand(' !propostas '),{action:'list',page:1});
 assert.deepEqual(parseLocalMarketReviewCommand('!propostas 2'),{action:'list',page:2});
 assert.deepEqual(parseLocalMarketReviewCommand('!proposta concluir ABCDEF012345'),{action:'complete',ticketId:'ABCDEF012345'});
 assert.equal(parseLocalMarketReviewCommand('!propostas 0'),null);
 assert.equal(parseLocalMarketReviewCommand('!proposta concluir not-an-id'),null);
 assert.equal(parseLocalMarketReviewCommand('texto !propostas'),null);
});

test('legacy local inbox items receive stable ticket IDs on migration',()=>{
 const item=proposal('legacy');
 delete item.ticketId;
 const state:{marketInbox?:MarketEvent[]}={marketInbox:[item]};
 ensureLocalMarketTicketIds(state);
 const first=item.ticketId;
 ensureLocalMarketTicketIds(state);
 assert.ok(first);
 assert.equal(item.ticketId,first);
});
