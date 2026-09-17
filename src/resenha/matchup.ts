import {createHash,randomInt} from 'node:crypto';
export type Coach={club:string;name:string;aliases:string[]};
const norm=(s:string)=>s.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
export function loadRoster(raw:string|undefined):Coach[]{
 if(!raw)return [];
 const list:unknown=JSON.parse(raw);
 if(!Array.isArray(list)||list.length>100||!list.every(c=>c&&typeof c.club==='string'&&typeof c.name==='string'&&Array.isArray(c.aliases)&&c.aliases.every((a:unknown)=>typeof a==='string')))throw Error('Invalid roster configuration');
 return list;
}
export function resolveCoach(input:string,roster:Coach[]):Coach[]{
 const q=' '+norm(input)+' ';
 const matches=roster.map(c=>({c,score:Math.max(0,...[c.club,c.name,...c.aliases].map(a=>{const n=norm(a);return n&&q.includes(' '+n+' ')?n.length:0;}))}));
 const best=Math.max(0,...matches.map(m=>m.score));
 return best?matches.filter(m=>m.score===best).map(m=>m.c):[];
}
export function matchupReply(text:string,roster:Coach[],group:string):string|null {
 const q=norm(text);
 if(!/\bquem (ganha|vence|leva)\b/.test(q))return null;
 if(!roster.length)return 'Ainda não tenho a lista de técnicos configurada. 🎮';
 const cleaned=q.replace(/\bquem (ganha|vence|leva)\b/g,' ').replace(/\bentre\b/g,' ').trim();
 const sides=cleaned.split(/\s+(?:x|vs|versus|ou|contra)\s+/);
 if(sides.length!==2)return 'Manda os dois lados: !bot Porto x Juventus quem ganha? 🍿';
 const a=resolveCoach(sides[0]!,roster),b=resolveCoach(sides[1]!,roster);
 if(a.length!==1||b.length!==1){
  const ambiguous=[...a,...b];
  return 'Qual técnico? Use o clube ou o nome completo'+(ambiguous.length?' — '+[...new Set(ambiguous.map(c=>c.name+' ('+c.club+')'))].join(', '):'')+'. 🎮';
 }
 if(a[0]===b[0])return 'É o mesmo técnico dos dois lados 😂 Manda outro adversário.';
 const pair=[a[0]!,b[0]!].sort((x,y)=>x.club.localeCompare(y.club));
 // Entertainment only: stable daily pick, not a ranking, result or inferred statistic.
 const seed=createHash('sha256').update(JSON.stringify([group,new Date().toISOString().slice(0,10),pair.map(c=>c.club)])).digest()[0]!;
 const pick=pair[seed%2]!;
 const lines=['Quem perder fica responsável pela coletiva de desculpas 😂','No console é jogo; aqui o pós-jogo vai até amanhã 🍿','O outro lado pode cobrar esse palpite depois, sem VAR 😂','Agora resolve no controle, porque no grupo os dois já são campeões 😂'];
 return `${a[0]!.name} (${a[0]!.club}) x ${b[0]!.name} (${b[0]!.club})\nMeu chute de resenha: ${pick.name}! ${lines[randomInt(lines.length)]}`;
}
