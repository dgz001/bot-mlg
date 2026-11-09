export type MarketResponse={group:string;messageId:string;participant:string;proposalMessageId:string|null;decision:'positive'|'negative'|'withdrawn';text:string;at:number};
export function marketResponse(input:{group:string;messageId:string;participant:string;proposalMessageId?:string|null;text?:string;reaction?:string;at?:number}):MarketResponse|null{
 const text=(input.text??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/\uFE0F/g,'').replace(/[.!]+$/,'');
 const reaction=(input.reaction??'').replace(/\uFE0F/g,'');
 const decision=input.reaction===''?'withdrawn':['✅','🟢','👍','✔'].includes(reaction)||['eu confirmo','eu aceito','confirmo','confirmado','confirmada','confirmo sim','confirmo a troca','confirmo a transferencia','confirmo a transferência','aceito','aceito a troca','sim confirmo','negociacao confirmada','negociação confirmada'].includes(text)?'positive':['❌','🔴','👎','✖'].includes(reaction)||['nao aceito','recuso','rejeito','nao confirmo','negociacao rejeitada','negociação rejeitada'].includes(text)?'negative':null;
 if(!decision)return null;
 return {group:input.group,messageId:input.messageId,participant:input.participant,proposalMessageId:input.proposalMessageId??null,decision,text:input.reaction||input.text||'',at:input.at??Date.now()};
}
