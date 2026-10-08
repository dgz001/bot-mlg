// Rotate waiting groups so missing permissions or unavailable groups cannot
// permanently starve entries beyond the first batch. Removal stays with caller.
export function loanJoinBatch(pending:string[],limit:number):string[]{
 const count=Math.min(pending.length,Math.max(0,Math.floor(limit)));
 const batch=pending.splice(0,count);pending.push(...batch);return batch;
}
