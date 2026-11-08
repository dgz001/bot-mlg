export type MarketResponse={group:string;messageId:string;participant:string;proposalMessageId:string|null;decision:'positive'|'negative'|'withdrawn';text:string;at:number};
const MAX_RESPONSE_TEXT=500;
const validGroup=(value:string)=>/^[0-9-]{5,40}@g\.us$/.test(value);
const validParticipant=(value:string)=>/^[0-9]+(?::[0-9]+)?@(lid|s\.whatsapp\.net)$/.test(value);
export function marketResponse(input:{group:string;messageId:string;participant:string;proposalMessageId?:string|null;text?:string;reaction?:string;at?:number}):MarketResponse|null{
 if(!validGroup(input.group)||!validParticipant(input.participant)||!input.messageId||input.messageId.length>200)return null;
 if(input.proposalMessageId!==undefined&&input.proposalMessageId!==null&&(!input.proposalMessageId||input.proposalMessageId.length>200))return null;
 const rawText=input.text??'';
 const rawReaction=input.reaction??'';
 if(rawText.length>MAX_RESPONSE_TEXT||rawReaction.length>16)return null;
 const text=rawText.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/[.!]+$/,'');
 const reaction=rawReaction.replace(/\uFE0F/g,'');
 const decision=input.reaction===''?'withdrawn':['✅','🟢','👍','✔'].includes(reaction)||['eu confirmo','eu aceito','confirmo','confirmado','aceito','sim confirmo','negociacao confirmada'].includes(text)?'positive':['❌','🔴','👎','✖'].includes(reaction)||['nao aceito','recuso','rejeito','nao confirmo','negociacao rejeitada'].includes(text)?'negative':null;
 if(!decision)return null;
 const at=input.at??Date.now();
 if(!Number.isSafeInteger(at)||at<0)return null;
 return {group:input.group,messageId:input.messageId,participant:input.participant,proposalMessageId:input.proposalMessageId??null,decision,text:rawReaction||rawText,at};
}
