import test from 'node:test';import assert from 'node:assert/strict';
import {minicampCommand,pendingCupBatch} from '../src/minicamp/client.ts';
test('canais pausados preservam a fila sem bloquear comandos de canais ativos',()=>{
 const events=Array.from({length:12},(_,i)=>({group:i<5?'paused':'active',aliases:['100@s.whatsapp.net'],id:String(i),name:'Teste',text:'!copa'}));
 assert.deepEqual(pendingCupBatch(events,g=>g==='active').map(e=>e.id),['5','6','7','8','9']);
 assert.deepEqual(pendingCupBatch(events,g=>g==='paused').map(e=>e.id),['0','1','2','3','4']);
 assert.equal(events.length,12);
 assert.deepEqual(pendingCupBatch(events,()=>false),[]);
});
test('cup commands are routed separately from resenha',()=>{
 for(const t of ['!supabase','!teste','!jornada','!jornada Nome completo','!arquivo 2','!vistoria','!titulo','!título Nome completo','!titulo Nome completo','!comandos','!chave','!chave A','!chave B','!lado A','!cadastrar @Maria','!editar @Maria | Maria Souza','!excluir @Maria','!meunome Novo nome','!confronto Arthur x Lucas','!forçar resultado 123 4x3','!novacopa','!nome Copa Nova','!categoria seleção','!formato 4','!jogos 1','!abrircopa','!entrar','!sorteio','!sorteio Samuel','!sorteio Rafael | Seleção indisponível','!meujogo','!proximafase','!próxima fase','!resenhacamp','!resultado 432 3x2','!confirmar 432','!stats','!ajuda','2'])assert.equal(minicampCommand(t),true);
 for(const t of ['!bot gs x amerio','bom dia','!entraroutra','25'])assert.equal(minicampCommand(t),false);
 for(const command of ['!campeoes','!historico','!proximafase','!forcarresultado'])assert.equal(minicampCommand(command),true);
});
