import test from 'node:test';
import assert from 'node:assert/strict';
import {isWhatsAppMarketProposalTooLong,MAX_WHATSAPP_MARKET_PROPOSAL_LENGTH,parseWhatsAppMarketProposal} from '../src/infra/market-proposal.ts';

test('market proposal input limit has an exact inclusive boundary',()=>{
 assert.equal(isWhatsAppMarketProposalTooLong('x'.repeat(MAX_WHATSAPP_MARKET_PROPOSAL_LENGTH)),false);
 assert.equal(isWhatsAppMarketProposalTooLong('x'.repeat(MAX_WHATSAPP_MARKET_PROPOSAL_LENGTH+1)),true);
});

test('oversized market text is rejected before it reaches the throwing parser',()=>{
 const oversized='x'.repeat(MAX_WHATSAPP_MARKET_PROPOSAL_LENGTH+1);
 assert.throws(()=>parseWhatsAppMarketProposal(oversized),/limite permitido/);
 assert.doesNotThrow(()=>{
  if(!isWhatsAppMarketProposalTooLong(oversized))parseWhatsAppMarketProposal(oversized);
 });
});

test('synthetic transfer scenarios preserve classification without executing a deal',()=>{
 const base='PROPOSTA DE COMPRA\nClube de origem: Seller FC\nJogador: Player One\nClube de destino: Buyer FC\nValor da transferência: €5 milhões';
 const internal=parseWhatsAppMarketProposal(base+'\nTipo de compra: interna')!;
 const external=parseWhatsAppMarketProposal(base.replace('Seller FC','Externo'))!;
 const trade=parseWhatsAppMarketProposal('PROPOSTA DE TROCA\nClube de origem: Seller FC\nJogador: Player One\nClube de destino: Buyer FC\nJogador de destino: Player Two')!;
 assert.equal(internal.purchaseScope,'internal');
 assert.equal(internal.amountEuros,'5000000');
 assert.equal(external.purchaseScope,'external');
 assert.equal(trade.kind,'trade');
 assert.deepEqual(trade.playersTo,['Player Two']);
 assert.equal(trade.amountEuros,'0');
 assert.deepEqual({balancesChanged:false,rostersChanged:false,approved:false},{balancesChanged:false,rostersChanged:false,approved:false});
});
