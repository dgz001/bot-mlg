import test from 'node:test';
import assert from 'node:assert/strict';
import {careers,careerText} from '../src/minicamp/career.ts';
import {apply,emptyState,type Cup} from '../src/minicamp/engine.ts';
import {minicampCommand} from '../src/minicamp/client.ts';
const cup=():Cup=>({id:'cup',groupId:'g',createdBy:'admin',createdAt:1,size:4,status:'completed',champion:'a',completedAt:20,participants:[{userId:'a',name:'Técnico A'},{userId:'b',name:'Técnico B'},{userId:'c',name:'Técnico C'},{userId:'d',name:'Técnico D'}],matches:[
 {code:100,round:0,position:0,home:'a',away:'b',status:'confirmed',winner:'a',results:[{home:3,away:1,author:'a',at:2,status:'confirmed',confirmedBy:'b'}]},
 {code:101,round:0,position:1,home:'c',away:'d',status:'confirmed',winner:'c',results:[{home:2,away:0,author:'c',at:3,status:'confirmed',confirmedBy:'d'}]},
 {code:102,round:1,position:0,home:'a',away:'c',status:'confirmed',winner:'a',results:[{home:2,away:1,author:'a',at:4,status:'confirmed',confirmedBy:'c'}]}
]});
test('carreira: campeão, vice, gols, pontos, rivalidades e dados ausentes',()=>{
 const rows=careers([cup()]);const a=rows[0]!;assert.equal(a.id,'a');assert.equal(a.points,128);assert.equal(a.gf,5);assert.equal(a.ga,2);assert.equal(a.titles,1);assert.equal(a.record,2);assert.deepEqual(a.medals,['Primeira taça']);assert.equal(a.nemesis,undefined);
 const c=rows.find(p=>p.id==='c')!;assert.equal(c.vices,1);assert.equal(c.points,49);assert.match(c.nemesis!,/Técnico A/);assert.match(careerText(c,2),/50.0%/);
 const zero=careers([],{z:'Estreante'})[0]!;assert.equal(zero.points,0);assert.match(careerText(zero,0),/0.0%/);assert.doesNotMatch(careerText(zero,0),/NaN|Infinity/);
});
test('revisões contam somente último placar e copas anuladas somem',()=>{
 const c=cup();c.matches[0]!.results.push({home:4,away:1,author:'admin',at:100,status:'confirmed',confirmedBy:'other'});
 assert.equal(careers([c])[0]!.gf,6);assert.equal(careers([c])[0]!.record,2);
 c.status='cancelled';assert.deepEqual(careers([c]),[]);
 c.status='playing';c.matches[2]!.status='pending';c.matches[2]!.results[0]!.status='pending';assert.equal(careers([c]).find(p=>p.id==='a')!.games,1);assert.equal(careers([c]).find(p=>p.id==='a')!.titles,0);
});
test('medalhas uma vez, invencibilidade e empate, confronto empatado sem vantagem',()=>{
 const c=cup();c.status='playing';c.matches=[];
 for(let i=0;i<10;i++)c.matches.push({code:200+i,round:0,position:i,home:'a',away:'b',status:'confirmed',winner:'a',results:[{home:1,away:0,author:'a',at:i,status:'confirmed'}]});
 let a=careers([c])[0]!;assert.equal(a.record,10);assert.equal(a.points,130);assert.equal(a.medals.length,2);
 c.matches.push({code:220,round:0,position:10,home:'a',away:'b',status:'confirmed',results:[{home:1,away:1,author:'a',at:20,status:'confirmed'}]});
 a=careers([c])[0]!;assert.equal(a.streak,0);assert.equal(a.unbeaten,11);assert.equal(a.draws,1);
 const t=cup();t.matches[2]!.away='b';t.matches[2]!.winner='b';t.matches[2]!.results[0]!.away=3;assert.equal(careers([t]).find(p=>p.id==='a')!.favorite,undefined);assert.equal(careers([t]).find(p=>p.id==='a')!.nemesis,undefined);
});
test('comandos: autorização, isolamento, cadastro, duplicidade e consulta por conta',()=>{
 let s=emptyState();s.groups.g={authorized:true,admins:['admin'],clubs:[]};s.groups.other={authorized:true,admins:[],clubs:[]};s.cups.cup=cup();let i=0;
 const send=(userId:string,text:string,groupId='g',id=String(++i))=>{const r=apply(s,{id,groupId,userId,name:'Visitante',text,at:i});s=r.state;return r;};
 assert.throws(()=>send('a','!registrarid x Novo'),/Somente ADM/);
 send('admin','!registrarid a Nome Oficial','g','register');assert.deepEqual(send('admin','!registrarid a Nome Oficial','g','register').notices,[]);
 assert.throws(()=>send('admin','!registrarid z Nôme Oficial'),/outra conta/);
 send('admin','!associarid a Outro Nome');assert.match(send('a','!carreira').notices[0]!,/Outro Nome/);
 assert.match(send('admin','!carreiraid a').notices[0]!,/Outro Nome/);
 assert.throws(()=>send('a','!revisarnumeros'),/Somente ADM/);
 assert.match(send('admin','!revisarnumeros').notices[0]!,/3 partidas/);
 assert.match(send('a','!moral').notices[0]!,/128 pts/);assert.throws(()=>send('a','!moral -1'),/Formato/);
 assert.match(send('a','!moral','other').notices[0]!,/ainda vai começar/);
 assert.match(send('a','!participantes').notices[0]!,/Outro Nome/);
 assert.throws(()=>send('a','!participantes cup','other'),/Nenhuma Copa/);
 assert.equal(s.audit.filter(a=>a.cupId===null).length,2);
 for(const name of ['carreira','moral','participantes','registrar','associar','sincronizarcontas','revisarnumeros'])assert.ok(minicampCommand('!'+name));
 for(const name of ['carreiraid','registrarid','associarid','contasverificadas'])assert.equal(minicampCommand('!'+name),false);
});
test('nomes homônimos exigem menção e ranking tem paginação',()=>{
 const s=emptyState();s.groups.g={authorized:true,admins:[],clubs:[]};s.profiles={g:Object.fromEntries(Array.from({length:11},(_,i)=>['u'+i,'Técnico']))};
 const send=(text:string)=>apply(s,{id:'x',groupId:'g',userId:'u0',name:'Técnico',text,at:1});
 assert.throws(()=>send('!carreira Técnico'),/ambíguo/);assert.match(send('!carreiraid u0').notices[0]!,/CARREIRA/);assert.match(send('!moral 2').notices[0]!,/11\. Técnico/);
});
