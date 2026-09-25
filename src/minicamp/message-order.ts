// WhatsApp timestamps have one-second resolution. Preserve arrival order on ties.
// The adapter processes batches in this order; Postgres locks the Cup group when
// assigning places. We cannot recover an absolute send order across delayed batches.
export function messageTime(value:unknown):number {
 if(typeof value==='number'&&Number.isFinite(value))return value;
 if(typeof value==='string'&&/^\d+$/.test(value))return Number(value);
 if(value&&typeof value==='object'&&'toNumber' in value&&typeof value.toNumber==='function'){
  const n=value.toNumber();return typeof n==='number'&&Number.isFinite(n)?n:0;
 }
 return 0;
}
export function orderMessages<T extends {messageTimestamp?:unknown}>(messages:readonly T[]):T[]{
 return messages.map((message,index)=>({message,index})).sort((a,b)=>{
  const x=messageTime(a.message.messageTimestamp),y=messageTime(b.message.messageTimestamp);
  return (x||Number.MAX_SAFE_INTEGER)-(y||Number.MAX_SAFE_INTEGER)||a.index-b.index;
 }).map(item=>item.message);
}
