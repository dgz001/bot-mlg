export type MarketResponse={group:string;messageId:string;participant:string;proposalMessageId:string|null;decision:'positive'|'negative'|'withdrawn';text:string;at:number};
export function marketResponse(input:{group:string;messageId:string;participant:string;proposalMessageId?:string|null;text?:string;reaction?:string;at?:number}):MarketResponse|null{
 const text=(input.text??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/[.!]+$/,'');
 const reaction=(input.reaction??'').replace(/\uFE0F/g,'');
 const decision=input.reaction===''?'withdrawn':['✅','🟢','👍','✔'].includes(reaction)||['confirmo','confirmado','aceito','sim confirmo','negociacao confirmada'].includes(text)?'positive':['❌','🔴','👎','✖'].includes(reaction)||['nao aceito','recuso','rejeito','nao confirmo','negociacao rejeitada'].includes(text)?'negative':null;
 if(!decision)return null;
 return {group:input.group,messageId:input.messageId,participant:input.participant,proposalMessageId:input.proposalMessageId??null,decision,text:input.reaction||input.text||'',at:input.at??Date.now()};
}
