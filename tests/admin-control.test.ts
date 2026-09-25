import test from 'node:test';
import assert from 'node:assert/strict';
import {adminControl,type ControlWorkspace} from '../src/infra/admin-control.ts';

test('central dos ADMs prepara, revisa e abre a Copa somente no grupo escolhido',async()=>{
 const room:ControlWorkspace={};let saves=0,opened=0,active=false,model='Copa do Mundo MLG';
 const calls:{action:string;group?:string}[]=[];
 const api=async(body:Record<string,unknown>)=>{
  calls.push({action:String(body.action),group:String(body.group)});
  switch(body.action){
   case 'competition-get':return {competition:{name:model,teamKind:'seleção',teams:['Brasil','Argentina','França','Portugal']}};
   case 'templates-list':return {activeCompetition:model,activeCup:active?{size:4,participants:0}:null,templates:[]};
   case 'template-save':return {saved:true,competition:{id:'saved-id'}};
   case 'template-activate':model=String(body.name??'Copa Global MLG');return {activated:true};
   case 'cup-open':assert.equal(body.group,'world@g.us');assert.equal(body.size,4);assert.equal((body.proposal as {name:string}).name,'Copa Global MLG');opened++;active=true;return {opened:true};
   default:throw Error('Unexpected action '+body.action);
  }
 };
 const targets=[{id:'mini@g.us',name:'Minicamp'},{id:'world@g.us',name:'Copa do Mundo'}];
 const send=(message:string,time=1000)=>adminControl(message,room,targets,api,async()=>{saves++;},time);
 assert.match(await send('!novacopa'),/Escolha primeiro/);
 await send('!usar 2');assert.equal(room.targetId,'world@g.us');
 await send('!novacopa');assert.equal(room.draft?.size,null);
 await send('!vagas 4');
 assert.match(await send('!abrircopa'),/Antes de abrir/);assert.equal(opened,0);
 assert.match(await send('!revisar'),/Copa do Mundo/);
 await send('!nome Copa Global MLG');
 assert.match(await send('!abrircopa'),/Antes de abrir/);assert.equal(opened,0);
 await send('!revisar',2000);
 assert.match(await send('!abrircopa',602_001),/10 minutos/);assert.equal(opened,0);
 await send('!revisar',602_000);
 assert.match(await send('!abrircopa',602_001),/aberta em Copa do Mundo/);
 assert.equal(opened,1);assert.equal(room.draft,undefined);assert.ok(saves>=6);
 assert.equal(calls.filter(c=>c.action==='cup-open').length,1);
 assert.ok(calls.every(c=>c.group==='world@g.us'));
});

test('central mostra a próxima edição e confirma o número liberado ao cancelar',async()=>{
 const room:ControlWorkspace={targetId:'world@g.us'};
 const targets=[{id:'world@g.us',name:'Copa do Mundo'}];
 const api=async(body:Record<string,unknown>)=>body.action==='templates-list'
  ?{activeCompetition:'Copa do Mundo MLG',activeCup:null,nextEdition:8}
  :body.action==='cup-cancel'?{cancelled:true,edition:8}:{error:'Comando inesperado'};
 const send=(message:string)=>adminControl(message,room,targets,api,async()=>{});
 assert.match(await send('!central'),/Próxima edição: 8/);
 assert.match(await send('!cancelarcopa Erro no sorteio'),/Edição 8 cancelada.*número fica livre/);
});

test('central impede times repetidos, evita destino removido e preserva a Copa ao descartar rascunho',async()=>{
 const room:ControlWorkspace={targetId:'world@g.us'};
 const targets=[{id:'world@g.us',name:'Copa'}];let calls=0;
 const api=async(body:Record<string,unknown>)=>{calls++;if(body.action==='competition-get')return {competition:{name:'Copa MLG',teamKind:'seleção',teams:['Brasil','França','Portugal','Argentina']}};return {templates:[],activeCup:null};};
 const send=(text:string,list=targets)=>adminControl(text,room,list,api,async()=>{});
 await send('!novacopa');
 assert.match(await send('!equipes Brasil | Brasil | Itália | Japão'),/diferentes/);
 assert.equal(room.draft?.teams.length,4);
 assert.match(await send('!vagas 32'),/pelo menos/);
 assert.match(await send('!descartar'),/Nenhuma Copa/);
 assert.equal(room.draft,undefined);
 assert.match(await send('!novacopa',[]),/Escolha primeiro/);
 assert.equal(calls,2);
});

test('sorteio exige confirmação, bloqueia mudança concorrente e preserva o motivo',async()=>{
 const room:ControlWorkspace={targetId:'world@g.us'};let version='a'.repeat(64),draws=0;
 const targets=[{id:'world@g.us',name:'Copa do Mundo'}];
 const api=async(body:Record<string,unknown>)=>{
  assert.equal(body.action,'cup-draw');assert.equal(body.group,'world@g.us');assert.equal(body.controlGroup,'central@g.us');
  if(body.mode){if(body.expected!==version)return {error:'O sorteio mudou depois da revisão.'};draws++;version='b'.repeat(64);return {changed:true};}
  return {cupId:'cup-1',name:'Copa do Mundo',fingerprint:version,participants:[{user_id:'u1',display_name:'Ana',club:'Brasil'},{user_id:'u2',display_name:'Beto',club:'França'}],matches:[{code:101,home:'u1',away:'u2'}]};
 };
 const send=(s:string,now=1000)=>adminControl(s,room,targets,api,async()=>{},now,{controlGroup:'central@g.us',aliases:['123@s.whatsapp.net']});
 assert.match(await send('!sorteio'),/Brasil/);
 assert.match(await send('!refazersorteio equipes erro na seleção'),/5 minutos/);
 version='c'.repeat(64);
 assert.match(await send('!confirmarsorteio'),/mudou depois/);assert.equal(draws,0);
 await send('!refazersorteio completo sorteio incorreto');
 assert.match(await send('!confirmarsorteio'),/Sorteio atualizado/);assert.equal(draws,1);
 assert.equal(room.draw,undefined);
 await send('!refazersorteio chave inverter sorteio');
 assert.match(await send('!confirmarsorteio',302_000),/Não há sorteio/);assert.equal(draws,1);
});

test('central prepara substituição de jogador e confirma só o elenco revisado',async()=>{
 const room:ControlWorkspace={targetId:'world@g.us'};let fingerprint='a'.repeat(64),updated=0;
 const api=async(body:Record<string,unknown>)=>{
  if(body.action!=='cup-roster')throw Error('Ação inesperada');
  if(body.change){if(body.expected!==fingerprint)return {error:'A lista da Copa mudou depois da revisão.'};updated++;return {changed:true};}
  return {cupId:'cup',name:'Copa do Mundo',status:'playing',size:4,fingerprint,participants:[{display_name:'Ana',club:'Brasil'},{display_name:'Beto',club:'França'},{display_name:'Caio',club:'Portugal'},{display_name:'Duda',club:'Japão'}]};
 };
 const actor={controlGroup:'central@g.us',aliases:['123@s.whatsapp.net'],resolveMember:async(_group:string,phone:string)=>phone==='5511999999999'?['5511999999999@s.whatsapp.net']:null};
 const send=(s:string)=>adminControl(s,room,[{id:'world@g.us',name:'Copa'}],api,async()=>{},1000,actor);
 assert.match(await send('!inscritosadm'),/2\. Beto/);
 assert.match(await send('!retirar 2 | pediu para sair'),/apenas a substituição/);
 assert.match(await send('!trocar 2 5511999999999 Eduardo | trocou de aparelho'),/Beto por Eduardo/);
 fingerprint='b'.repeat(64);
 assert.match(await send('!confirmarelenco'),/mudou depois/);assert.equal(updated,0);
 await send('!trocar 2 5511999999999 Eduardo | trocou de aparelho');
 assert.match(await send('!confirmarelenco'),/Participantes atualizados/);assert.equal(updated,1);
});
