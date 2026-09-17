import {createHash,randomInt} from 'node:crypto';
export type ReplyHistory=Record<string,string[]>;
// Persist only hashes of authored replies, never raw group messages.
export function chooseReply(group:string,options:string[],history:ReplyHistory):string {
 if(!options.length)throw Error('Empty reply bank');
 const key=createHash('sha256').update(group).digest('hex');
 const recent=history[key]??[];
 const entries=options.map(text=>({text,id:createHash('sha256').update(text).digest('hex')}));
 let pool=entries.filter(e=>!recent.includes(e.id));
 if(!pool.length){const oldest=Math.min(...entries.map(e=>recent.indexOf(e.id)));pool=entries.filter(e=>recent.indexOf(e.id)===oldest);}
 const pick=pool[randomInt(pool.length)]!;
 if(!history[key]&&Object.keys(history).length>=100)delete history[Object.keys(history)[0]!];
 history[key]=[...recent.filter(id=>id!==pick.id),pick.id].slice(-160);
 return pick.text;
}
