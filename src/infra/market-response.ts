export type MarketResponse={group:string;messageId:string;participant:string;proposalMessageId:string|null;decision:'positive'|'negative'|'withdrawn';text:string;at:number};
export function marketResponse(input:{group:string;messageId:string;participant:string;proposalMessageId?:string|null;text?:string;reaction?:string;proposalKind?:'transfer'|'trade'|'loan';at?:number}):MarketResponse|null{
 const text=(input.text??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/\uFE0F/g,'').replace(/[.!]+$/,'');
 const reaction=(input.reaction??'').replace(/\uFE0F/g,'');
 const positive=(input.proposalKind==='loan'?reaction==='🔵':input.proposalKind==='trade'?['✅','🟢'].includes(reaction):['✅','🟢','👍','✔'].includes(reaction))||['✅','🟢','👍','✔'].includes(text)||['eu confirmo','eu aceito','confirmo','confirmado','confirmada','confirmo sim','confirmo a troca','confirmo a transferencia','aceito','aceito a troca','sim confirmo','negociacao confirmada'].includes(text);
 const negative=['❌','🔴','👎','✖'].includes(reaction)||['❌','🔴','👎','✖'].includes(text)||['nao aceito','recuso','rejeito','nao confirmo','negociacao rejeitada'].includes(text);
 const decision=positive?'positive':negative?'negative':input.reaction!==undefined?'withdrawn':null;
 if(!decision)return null;
 return {group:input.group,messageId:input.messageId,participant:input.participant,proposalMessageId:input.proposalMessageId??null,decision,text:input.reaction||input.text||'',at:input.at??Date.now()};
}
