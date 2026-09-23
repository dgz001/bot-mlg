import type {Cup} from './engine.ts';
export const normalizeName=(s:string)=>s.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/\s+/g,' ');
export function careers(cups:Cup[], names:Record<string,string>={}){
 const valid=cups.filter(c=>c.status!=='cancelled').sort((a,b)=>a.createdAt-b.createdAt);
 const people=new Map<string,string>();for(const c of valid)for(const p of c.participants)people.set(p.userId,p.name);
 for(const [id,name] of Object.entries(names))people.set(id,name);
 return [...people].map(([id,name])=>{
  let wins=0,draws=0,losses=0,gf=0,ga=0,streak=0,record=0,unbeaten=0,bestUnbeaten=0;
  const rivals=new Map<string,{wins:number;losses:number}>();
  const matches=valid.flatMap(c=>c.matches).filter(m=>m.status==='confirmed'&&m.results.at(-1)?.status==='confirmed'&&[m.home,m.away].includes(id)).sort((a,b)=>a.results[0]!.at-b.results[0]!.at||a.code-b.code);
  for(const m of matches){const r=m.results.at(-1)!;const h=m.home===id;const scored=h?r.home:r.away, conceded=h?r.away:r.home;gf+=scored;ga+=conceded;
   const opponent=h?m.away:m.home;const duel=rivals.get(opponent)??{wins:0,losses:0};
   if(scored>conceded){wins++;streak++;unbeaten++;duel.wins++;}else if(scored===conceded){draws++;streak=0;unbeaten++;}else{losses++;streak=0;unbeaten=0;duel.losses++;}
   record=Math.max(record,streak);bestUnbeaten=Math.max(bestUnbeaten,unbeaten);rivals.set(opponent,duel);
  }
  const completed=valid.filter(c=>c.status==='completed');const titles=completed.filter(c=>c.champion===id).length;
  const vices=completed.filter(c=>c.champion!==id&&c.matches.some(m=>m.round===Math.log2(c.size)-1&&m.status==='confirmed'&&[m.home,m.away].includes(id))).length;
  const milestones=[{name:'Primeira taça',value:titles,target:1,bonus:10},{name:'Sequência de respeito',value:record,target:5,bonus:15},{name:'Muralha',value:bestUnbeaten,target:10,bonus:25}];
  const medals=milestones.filter(m=>m.value>=m.target);const bonus=medals.reduce((n,m)=>n+m.bonus,0);
  const points=titles*100+vices*40+wins*5+draws*2+record*2+bestUnbeaten*2+bonus;
  const rivalry=(direction:number)=>[...rivals].filter(([,r])=>(r.wins-r.losses)*direction>0).sort((a,b)=>((b[1].wins-b[1].losses)-(a[1].wins-a[1].losses))*direction||a[0].localeCompare(b[0])).map(([who,r])=>`${people.get(who)??'Participante'} (${r.wins}V–${r.losses}D)`)[0];
  return {id,name,wins,draws,losses,gf,ga,streak,record,unbeaten,bestUnbeaten,titles,vices,games:matches.length,points,medals:medals.map(m=>m.name),next:milestones.find(m=>m.value<m.target),favorite:rivalry(1),nemesis:rivalry(-1)};
 }).sort((a,b)=>b.points-a.points||b.titles-a.titles||b.wins-a.wins||a.id.localeCompare(b.id));
}
export function careerText(p:ReturnType<typeof careers>[number],rank:number){return `🎮 CARREIRA NA ARENA\n${p.name}\n\n🏆 ${p.titles} títulos · 🥈 ${p.vices} vices\n⭐ Moral: ${p.points} pontos · ${rank?`${rank}º lugar`:'sem posição'}\n\n⚽ DENTRO DE CAMPO\n${p.games} jogos · ${p.wins}V / ${p.draws}E / ${p.losses}D\n📈 Aproveitamento: ${p.games?((p.wins*3+p.draws)/(p.games*3)*100).toFixed(1):'0.0'}%\n🥅 Gols: ${p.gf} feitos / ${p.ga} sofridos · saldo ${p.gf-p.ga}\n\n🔥 FASE ATUAL\nInvicto: ${p.unbeaten} · recorde ${p.bestUnbeaten}\nVitórias seguidas: ${p.streak} · recorde ${p.record}\n\n🏅 CONQUISTAS\n${p.medals.join(' • ')||'A primeira medalha ainda está por vir!'}\n${p.next?`🎯 Próxima: ${p.next.name} (${p.next.value}/${p.next.target})`:'✨ Todas as medalhas desta versão conquistadas!'}\n\n🍿 RIVALIDADES\nVantagem sobre: ${p.favorite??'nenhum rival por enquanto'}\nPedra no caminho: ${p.nemesis??'ninguém com vantagem'}\n\nSó resultados confirmados deste grupo. W.O. entra como 3x0; Copas anuladas não contam.`;}
