import test from 'node:test';
import assert from 'node:assert/strict';
import {adminControl,guestPrepared,type ControlWorkspace} from '../src/infra/admin-control.ts';
import {loanCommand,loanGuide,loanPhone} from '../src/infra/loan-invitation.ts';
test('convite aceita acentos e telefone formatado e não anuncia envio sem remetente',async()=>{
 assert.equal(loanCommand('!empréstimo +55 (11) 88888-8888'),'!emprestimo +55 (11) 88888-8888');
 assert.equal(loanCommand('!empréstar 5511888888888'),'!emprestar 5511888888888');
 assert.equal(loanCommand('!dar ADM 5511888888888'),'!daradm 5511888888888');
 for(const [input,expected] of [['!campeões','!campeoes'],['!histórico 2','!historico 2'],['!próximafase','!proximafase'],['!forçarresultado 42 1x0','!forcarresultado 42 1x0']] as const)assert.equal(loanCommand(input),expected);
 assert.equal(loanPhone('+55 (11) 88888-8888'),'5511888888888');
 assert.equal(loanPhone('5511888888888 errado'),null);
 const calls:Record<string,unknown>[]=[],sent:string[]=[];
 const api=async(body:Record<string,unknown>)=>{calls.push(body);return {invited:true,existing:true};};
 const actor={controlGroup:'central@g.us',aliases:['5511999999999@s.whatsapp.net']};
 const send=(text:string,by=actor)=>adminControl(text,{},[],api,async()=>{},Date.now(),by);
 assert.match(await send('!empréstimo +55 (11) 88888-8888'),/não confirmou o envio/);
 assert.deepEqual(calls[0]?.targetAliases,['5511888888888@s.whatsapp.net']);
 const delivered=await send('!emprestar 5511888888888',{...actor,sendInvitation:async(phone:string,guide:string)=>{sent.push(phone,guide);}} as typeof actor);
 assert.match(delivered,/já registrado.*guia foi enviado/s);
 assert.deepEqual(sent,['5511888888888',loanGuide]);
 assert.match(loanGuide,/!modalidade liga.*!modalidade copa/);
 assert.match(loanGuide,/!jogos 1.*!jogos 2/);
 assert.match(loanGuide,/Adicione este bot ao grupo.*administrador do grupo/s);
 assert.match(loanGuide,/!configbot.*!alterarconfig/s);
 assert.match(loanGuide,/!novacopa no grupo publica/);
 assert.match(loanGuide,/!forcarresultado CÓDIGO MxV motivo/);
 assert.match(loanGuide,/Ninguém acompanha este chat como atendimento humano/);
 assert.match(loanGuide,/aceita somente os comandos de configuração/);
 const failed=await send('!emprestar 5511888888888',{...actor,sendInvitation:async()=>{throw Error('offline');}} as typeof actor);
 assert.match(failed,/repita !emprestar 5511888888888/);
 assert.doesNotMatch(failed,/guia foi enviado/);
});
test('organizador pode cancelar a edição sem motivo, sem confundir com partida',async()=>{
 const group='convidado@g.us',room:ControlWorkspace={targetId:group},calls:Record<string,unknown>[]=[];
 const send=(command:string)=>adminControl(command,room,[],async payload=>{calls.push(payload);return {cancelled:true};},async()=>{},Date.now(),undefined,undefined,true);
 assert.match(await send('!cancelar copa'),/Campeonato cancelado/);
 assert.deepEqual(calls[0],{action:'guest-cancel',group,reason:'Cancelamento administrativo pelo WhatsApp'});
 assert.match(await send('!cancelarcopa Problema no sorteio'),/Campeonato cancelado/);
 assert.deepEqual(calls[1],{action:'guest-cancel',group,reason:'Problema no sorteio'});
 assert.match(await send('!cancelar 42'),/reservado/);
 assert.equal(calls.length,2);
});
test('empréstimo exige administrador do grupo e gestão convidada fica restrita ao próprio canal',async()=>{
 const group='convidado@g.us',room:ControlWorkspace={},calls:Record<string,unknown>[]=[],messages:string[]=[];
 const actor={controlGroup:'central@g.us',aliases:['5511999999999@s.whatsapp.net'],messageId:'wa-50',sendInvitation:async(phone:string,guide:string)=>{messages.push(phone,guide);}};
 const api=async(payload:Record<string,unknown>)=>{calls.push(payload);return payload.action==='loan-invite'&&payload.operation==='get'?{invitations:[{name:'Amério',jid:'5511888888888@s.whatsapp.net'}]}:{invited:true,revoked:true};};
 const send=(command:string)=>adminControl(command,room,[{id:group,name:'Liga do Amério'}],api,async()=>{},Date.now(),actor);
 assert.match(await send('!emprestar errado'),/DDI e DDD/);assert.equal(calls.length,0);
 assert.match(await send('!emprestar 5511888888888'),/guia foi enviado/);
 assert.deepEqual(calls[0],{action:'loan-invite',source:'central@g.us',aliases:actor.aliases,operation:'grant',targetAliases:['5511888888888@s.whatsapp.net']});
 assert.equal(messages[0],'5511888888888');assert.match(messages[1]!,/aceita somente os comandos de configuração/);
 assert.match(await send('!emprestimo'),/5511888888888/);
 assert.match(await send('!devolverbot 5511888888888'),/cancelado/);
 room.targetId=group;
 assert.match(await send('!devolverbot'),/encerrado/);
 const loanRoom:ControlWorkspace={targetId:group};let touched=0;
 const guest=async(command:string)=>adminControl(command,loanRoom,[{id:group,name:'Liga do Amério'}],async payload=>{touched++;assert.equal(payload.group,group);return {competition:{name:'Liga',teamKind:'clube',teams:['A','B','C','D']},activeCup:null,preparing:false};},async()=>{},Date.now(),{controlGroup:group,aliases:['5511888888888@s.whatsapp.net'],messageId:'wa-51'}, {[group]:loanRoom},true);
 assert.match(await guest('!painel'),/ORGANIZADOR/);
 assert.match(await guest('!reiniciar temporada'),/reservado/);
 assert.match(await guest('!daradm 5511777777777 | geral'),/Use !daradm/);
 assert.match(await guest('!grupos'),/reservado/);
 assert.equal(touched,0);
 assert.match(await guest('!novacopa'),/NOVO CAMPEONATO/);
 assert.equal(touched,1);
});
test('organizador escolhe liga ou copa e ida e volta antes de abrir vagas',async()=>{
 const group='convidado@g.us',room:ControlWorkspace={targetId:group};const calls:Record<string,unknown>[]=[];
 const api=async(payload:Record<string,unknown>)=>{calls.push(payload);return payload.action==='guest-status'?{cup:null}:{opened:true};};
 const send=(value:string)=>adminControl(value,room,[{id:group,name:'Convidado'}],api,async()=>{},Date.now(),{controlGroup:group,aliases:['5511888888888@s.whatsapp.net']},{[group]:room},true);
 assert.match(await send('!novacopa'),/NOVO CAMPEONATO/);
 assert.match(await send('!modalidade liga'),/Atualizado/);
 assert.match(await send('!vagas 3'),/Atualizado/);
 assert.match(await send('!jogos 2'),/Atualizado/);
 await send('!nome Liga do Amério');
 await send('!equipes Palmeiras | Bahia | Santos');
 assert.match(await send('!revisar'),/Pontos corridos · ida e volta/);
 assert.match(await send('!abrircopa'),/inscrições abertas/);
 assert.deepEqual(calls.at(-1),{action:'guest-open',group,name:'Liga do Amério',mode:'liga',legs:2,size:3,teams:['Palmeiras','Bahia','Santos']});
 assert.equal(room.guestDraft,undefined);
});
test('configuração convidada aceita termos esportivos e exige revisar de novo após mudar',async()=>{
 const group='convidado@g.us',room:ControlWorkspace={targetId:group};let opened=0;
 const send=(text:string)=>adminControl(text,room,[],async request=>{if(request.action==='guest-open')opened++;return {cup:null,opened:true};},async()=>{},Date.now(),undefined,undefined,true);
 await send('!novacopa');await send('!modalidade pontos corridos');await send('!formato 3');await send('!jogos ida e volta');await send('!equipes Bahia | Santos | Palmeiras');
 assert.match(await send('!revisar'),/Pontos corridos · ida e volta/);
 assert.match(await send('!abrircopa'),/inscrições abertas/);assert.equal(opened,1);
 await send('!novacopa');await send('!modalidade mata-mata');await send('!vagas 4');await send('!equipes Bahia | Santos | Palmeiras | Flamengo');await send('!revisar');await send('!jogos ida e volta');
 assert.match(await send('!abrircopa'),/Revise/);assert.equal(opened,1);
 assert.match(await send('!revisar'),/Mata-mata · ida e volta/);
 assert.match(await send('!abrircopa'),/inscrições abertas/);assert.equal(opened,2);
});
test('organizador escolhe a foto do próprio grupo ou texto sem alterar a Copa',async()=>{
 const room:ControlWorkspace={targetId:'convidado@g.us'};let saves=0;
 const send=(text:string)=>adminControl(text,room,[],async()=>({cup:null}),async()=>{saves++;},Date.now(),undefined,undefined,true);
 assert.match(await send('!imagemgrupo'),/foto do grupo onde você publicar/);
 assert.equal(room.guestImage,'group');
 await send('!novacopa');
 assert.equal(room.guestImage,'group');
 assert.match(await send('!imagemtexto'),/sem imagens da MLG/);
 assert.equal(room.guestImage,'text');assert.equal(saves,3);
 assert.match(await send('!painel'),/um time por linha/);
});
test('organizador aceita lista longa, corrige um clube e revisa de novo',async()=>{
 const room:ControlWorkspace={targetId:'convidado@g.us'},api=async(body:Record<string,unknown>)=>body.action==='guest-status'?{cup:null}:{opened:true};
 const send=(text:string)=>adminControl(text,room,[],api,async()=>{},Date.now(),undefined,undefined,true);
 await send('!novacopa');await send('!modalidade liga');await send('!vagas 3');
 const clubs=Array.from({length:220},(_,i)=>'Clube '+i);
 await send('!equipes '+clubs.slice(0,100).join('\n'));
 await send('!adicionar '+clubs.slice(100).join('\n'));
 assert.equal(room.guestDraft?.teams.length,220);
 assert.match(await send('!times 9'),/220\. Clube 219/);
 assert.match(await send('!corrigirclubes Clube 0 | Clube certo'),/Atualizado/);
 assert.match(await send('!corrigirclubes Clube 1 | Clube certo'),/já cadastrado/);
 assert.match(await send('!revisar'),/220 times/);
 await send('!remover Clube 219');
 assert.match(await send('!abrircopa'),/Revise/);
});
test('preparo no privado salva por organizador e exige nova confirmação após edição',async()=>{
 const a:ControlWorkspace={targetId:'private'},b:ControlWorkspace={targetId:'private'};
 const send=(room:ControlWorkspace,text:string)=>adminControl(text,room,[],async()=>{throw Error('O privado não deve publicar a Copa');},async()=>{},Date.now(),undefined,undefined,true,true);
 assert.match(await send(a,'!novacopa'),/PREPARO PRIVADO/);
 await send(a,'!nome Campeonato do Amério');await send(a,'!modalidade liga');await send(a,'!vagas 3');await send(a,'!jogos 2');await send(a,'!equipes Santos\nBahia\nFlamengo');
 assert.match(await send(a,'!confirmar'),/Revise/);
 assert.match(await send(a,'!revisar'),/Envie !confirmar/);
 assert.match(await send(a,'!confirmar'),/salva no seu privado/);
 assert.deepEqual(guestPrepared(a),{name:'Campeonato do Amério',mode:'liga',legs:2,size:3,teams:['Santos','Bahia','Flamengo']});
 assert.equal(guestPrepared(b),null);
 assert.match(await send(a,'!abrircopa'),/No privado/);
 await send(a,'!corrigirclubes Bahia | Palmeiras');assert.equal(guestPrepared(a),null);
 await send(a,'!revisar');await send(a,'!confirmar');assert.deepEqual(guestPrepared(a)?.teams,['Santos','Palmeiras','Flamengo']);
});
test('preparo misto escolhe oito classificados e invalida revisão ao mudar vagas',async()=>{
 const room:ControlWorkspace={targetId:'private'};
 const send=(text:string)=>adminControl(text,room,[],async()=>({}),async()=>{},Date.now(),undefined,undefined,true,true);
 await send('!novacopa');await send('!nome Brasileirão convidado');await send('!modalidade misto');await send('!vagas 10');
 await send('!equipes '+Array.from({length:10},(_,i)=>'Clube '+i).join('\n'));
 assert.match(await send('!classificados 8'),/Atualizado/);
 assert.match(await send('!revisar'),/Pontos corridos → mata-mata · 8 avançam/);
 await send('!confirmar');assert.equal(guestPrepared(room)?.qualifiers,8);
 assert.match(await send('!vagas 8'),/Atualizado/);assert.equal(guestPrepared(room),null);
 assert.match(await send('!revisar'),/menor que !vagas/);
 await send('!classificados 4');await send('!revisar');await send('!confirmar');assert.equal(guestPrepared(room)?.qualifiers,4);
});
test('auxiliar convidado depende da permissão do grupo, sem papel geral',async()=>{
 const room:ControlWorkspace={targetId:'convidado@g.us'},calls:Record<string,unknown>[]=[],aliases=['5511888888888@s.whatsapp.net'];
 const api=async(body:Record<string,unknown>)=>{calls.push(body);return body.operation==='list'?{admins:[{role:'manager',jid:aliases[0]}]}:{updated:true};};
 const actor={aliases,controlGroup:room.targetId!,resolveGroupAdmin:async()=>['5511777777777@s.whatsapp.net']};
 const send=(text:string)=>adminControl(text,room,[],api,async()=>{},Date.now(),actor,undefined,true);
 assert.match(await send('!daradm 5511777777777'),/apenas neste grupo/);
 assert.deepEqual(calls[0],{action:'guest-admin',group:room.targetId,aliases,operation:'grant',targetAliases:['5511777777777@s.whatsapp.net']});
 assert.match(await send('!adms'),/Organizador/);
 assert.match(await send('!tiraradm 5511777777777'),/removido/);
 assert.match(await send('!bloquear 5511777777777'),/reservado/);
});
test('troca de temporada exige revisão, mesmo ADM e código válido dentro do prazo',async()=>{
 const room:ControlWorkspace={},actor={controlGroup:'adm@g.us',aliases:['5511999999999@s.whatsapp.net'],messageId:'wa-1'};
 const calls:Record<string,unknown>[]=[];let reset=0,saves=0;
 const api=async(body:Record<string,unknown>)=>{calls.push(body);
  if(body.action==='season-preview')return {season:3,cups:12,matches:30,active:0,fingerprint:'snapshot-3'};
  if(body.action==='season-reset'){reset++;return {season:4};}
  throw Error('Unexpected request');
 };
 const send=(text:string,at=1000,by=actor)=>adminControl(text,room,[],api,async()=>{saves++;},at,by);
 assert.match(await send('!confirmar temporada 12345678'),/inválida/);assert.equal(reset,0);
 const preview=await send('!reiniciar temporada');assert.match(preview,/12 Copas e 30 partidas/);
 const token=room.seasonReset!.code;assert.match(preview,new RegExp(token));
 assert.match(await send('!confirmar temporada '+token,1001,{...actor,aliases:['outro@s.whatsapp.net']}),/inválida/);
 assert.match(await send('!confirmar temporada '+token,601001),/vencida/);
 assert.equal(reset,0);
 assert.match(await send('!reiniciar temporada',700000),/REINÍCIO/);
 const nextToken=room.seasonReset!.code;
 assert.match(await send('!confirmar temporada '+nextToken,700001),/TEMPORADA REINICIADA/);
 assert.equal(reset,1);assert.equal(room.seasonReset,undefined);assert.ok(saves>=3);
 assert.deepEqual(calls.at(-1),{action:'season-reset',source:'adm@g.us',aliases:actor.aliases,messageId:'wa-1',fingerprint:'snapshot-3'});
 assert.match(await send('!confirmar temporada '+nextToken,700002),/inválida/);assert.equal(reset,1);
});
test('Copa em andamento impede preparar reinício e é possível cancelar o pedido',async()=>{
 const room:ControlWorkspace={};let active=true;
 const api=async()=>({season:1,cups:2,matches:5,active:Number(active),fingerprint:'snapshot'});
 const send=(cmd:string)=>adminControl(cmd,room,[],api,async()=>{},Date.now(),{controlGroup:'adm@g.us',aliases:['123@s.whatsapp.net'],messageId:'wa'});
 assert.match(await send('!reiniciar temporada'),/em andamento/);assert.equal(room.seasonReset,undefined);
 active=false;await send('!reiniciar temporada');assert.ok(room.seasonReset);
 assert.match(await send('!cancelar temporada'),/descartado/);assert.equal(room.seasonReset,undefined);
});
test('ADM usa outra sala autorizada para corrigir a Copa selecionada com identidade verificada',async()=>{
 const room:ControlWorkspace={targetId:'copa@g.us'},calls:Record<string,unknown>[]=[];
 const actor={controlGroup:'resenha@g.us',aliases:['123@s.whatsapp.net'],messageId:'wa-42'};
 const send=(text:string,identity:typeof actor|null=actor)=>adminControl(text,room,[{id:'copa@g.us',name:'Copa do Mundo'}],async payload=>{calls.push(payload);return {accepted:true};},async()=>{},Date.now(),identity??undefined);
 assert.match(await send('!forcarresultado 158 3x2 Erro confirmado'),/registrado em Copa do Mundo/);
 assert.deepEqual(calls[0],{action:'admin-cup-command',source:'resenha@g.us',group:'copa@g.us',aliases:actor.aliases,messageId:'wa-42',text:'!forcarresultado 158 3x2 Erro confirmado'});
 assert.match(await send('!resolver 158 3x2 Motivo revisado'),/registrado/);
 assert.match(await send('!vistoria'),/registrado/);
 assert.match(await send('!deletar sem-codigo'),/Use !deletar código/);
 assert.equal(calls.length,3);
 assert.match(await send('!forcarresultado 158 3x2',null),/verificada/);
});

test('bloqueio exige ADM, conta verificada, motivo e permite reversão auditável',async()=>{
 const room:ControlWorkspace={targetId:'copa@g.us'};
 const calls:Record<string,unknown>[]=[];
 const api=async(body:Record<string,unknown>)=>{calls.push(body);return body.operation==='list'?{members:[]}:{updated:true};};
 const actor={controlGroup:'central@g.us',aliases:['123@s.whatsapp.net'],resolveMember:async(_group:string,phone:string)=>phone==='5511999999999'?['5511999999999@s.whatsapp.net']:null};
 const send=(text:string,withActor=true)=>adminControl(text,room,[{id:'copa@g.us',name:'Copa'}],api,async()=>{},Date.now(),withActor?actor:undefined);
 assert.match(await send('!bloquear 5511999999999 | Quebra das regras',false),/validar o ADM/);
 assert.match(await send('!bloquear 5511888888888 | Quebra das regras'),/não localizada/);
 assert.match(await send('!bloquear 5511999999999 | curto'),/8 a 160/);
 assert.match(await send('!bloquear 5511999999999 | Quebra das regras'),/bloqueada/);
 assert.equal(calls.at(-1)?.operation,'block');assert.equal(calls.at(-1)?.group,'central@g.us');
 assert.match(await adminControl('!bloquear 5511999999999',{},[],api,async()=>{},Date.now(),{...actor,resolveMemberAnywhere:async()=>['5511999999999@s.whatsapp.net']}),/bloqueada/);
 assert.equal(calls.at(-1)?.reason,'Bloqueio administrativo pelo WhatsApp');
 assert.match(await send('!desbloquear 5511999999999 | Reintegração aprovada'),/desbloqueada/);
 assert.equal(calls.at(-1)?.operation,'unblock');
 assert.match(await send('!bloqueados'),/Nenhuma conta bloqueada/);
});

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
 assert.match(await send('!revisar'),/Confirme os times/);
 await send('!confirmartimes');
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

test('ADM prepara na administração e publica no mesmo canal após cancelar Copa em andamento',async()=>{
 const workspaces:Record<string,ControlWorkspace>={'admin@g.us':{},'copa@g.us':{targetId:'copa@g.us'}};
 const targets=[{id:'copa@g.us',name:'Copa Mundial'}];let active=true,openCount=0,saves=0;
 const api=async(payload:Record<string,unknown>):Promise<any>=>{
  if(payload.action==='templates-list')return {activeCup:active?{id:'old'}:null,preparing:false};
  if(payload.action==='cup-cancel'){active=false;return {cancelled:true,edition:1};}
  if(payload.action==='competition-get')return {competition:{name:'Copa Mundial',teamKind:'seleção',teams:['Brasil','Itália','Egito','França']}};
  if(payload.action==='cup-open'){assert.equal(payload.group,'copa@g.us');assert.equal(payload.size,4);assert.equal((payload.proposal as {name:string}).name,'Nova Copa');active=true;openCount++;return {opened:true,edition:1};}
  throw Error('Ação inesperada: '+payload.action);
 };
 const send=(group:string,command:string,now=1000)=>adminControl(command,workspaces[group]!,targets,api,async()=>{saves++;},now,{controlGroup:group,aliases:['100@s.whatsapp.net'],messageId:'admin-'+command},workspaces);
 assert.match(await send('admin@g.us','!usar 1'),/Copa Mundial/);
 assert.match(await send('admin@g.us','!cancelarcopa Motivo administrativo'),/cancelada/);
 await send('admin@g.us','!novacopa');await send('admin@g.us','!nome Nova Copa');await send('admin@g.us','!equipes Brasil | Itália | Egito | França');await send('admin@g.us','!vagas 4');
 await send('admin@g.us','!revisar');
 assert.match(await send('admin@g.us','!concluir'),/pronta para Copa Mundial/);
 assert.equal(active,false);assert.equal(openCount,0);
 assert.equal(workspaces['copa@g.us']?.staged?.name,'Nova Copa');
 assert.match(await send('admin@g.us','!novacopa'),/Um ADM deve enviar !novacopa/);
 assert.match(await send('copa@g.us','!novacopa'),/aberta neste canal/);
 assert.equal(workspaces['copa@g.us']?.staged,undefined);assert.equal(openCount,1);
 assert.match(await send('copa@g.us','!novacopa'),/Já há uma Copa aberta/);
 assert.equal(openCount,1);assert.ok(saves>=5);
});

test('ADM geral concede acesso restrito por canal via WhatsApp e pode retirar',async()=>{
 const room:ControlWorkspace={targetId:'mini@g.us'};const calls:Record<string,unknown>[]=[];
 const api=async(body:Record<string,unknown>)=>{calls.push(body);return body.operation==='list'?{admins:[{name:'Amigo',role:'channel',jid:'5599999999999@s.whatsapp.net'}]}:{updated:true,role:body.role};};
 const actor={controlGroup:'central@g.us',aliases:['5511999999999@s.whatsapp.net'],messageId:'wa',resolveMember:async(group:string,phone:string)=>group==='mini@g.us'&&phone==='5599999999999'?['5599999999999@s.whatsapp.net']:null};
 const send=(cmd:string)=>adminControl(cmd,room,[{id:'mini@g.us',name:'Mini Camp'}],api,async()=>{},1000,actor);
 assert.match(await send('!adms'),/Amigo.*somente este canal/);
 assert.match(await send('!daradm 5599999999999 | canal'),/somente este canal/);
 assert.equal(calls.at(-1)?.role,'channel');
 assert.equal(calls.at(-1)?.group,'mini@g.us');
 assert.match(await send('!daradm +55 (99) 99999-9999'),/somente este canal/);
 assert.equal(calls.at(-1)?.role,'channel');
 assert.match(await adminControl('!daradm 5599999999999 | geral',{},[{id:'mini@g.us',name:'Mini Camp'}],api,async()=>{},1000,{...actor,resolveMemberAnywhere:async()=>['5599999999999@s.whatsapp.net']}),/ADM geral/);
 assert.equal(calls.at(-1)?.role,'admin');
 assert.match(await adminControl('!dar ADM 5599999999999 | geral',{},[{id:'mini@g.us',name:'Mini Camp'},{id:'copa@g.us',name:'Copa'}],api,async()=>{},1000,{...actor,resolveMemberAnywhere:async()=>['5599999999999@s.whatsapp.net']}),/ADM geral/);
 assert.equal(calls.at(-1)?.group,'central@g.us');
 assert.match(await send('!tiraradm 5599999999999'),/Acesso removido/);
 assert.equal(calls.at(-1)?.operation,'revoke');
 assert.match(await send('!daradm 5511888888888 | geral'),/algum grupo autorizado/);
});

test('central não anula edição enquanto banco usa a numeração antiga',async()=>{
 const room:ControlWorkspace={targetId:'world@g.us'};
 const targets=[{id:'world@g.us',name:'Copa do Mundo'}];let voids=0;
 const api=async(body:Record<string,unknown>)=>{if(body.action==='cup-void')voids++;return {recentCups:[]};};
 const answer=await adminControl('!anularcopa 8 Corrigir a copa',room,targets,api,async()=>{});
 assert.match(answer,/aguardando a atualização da numeração/);
 assert.equal(voids,0);
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
