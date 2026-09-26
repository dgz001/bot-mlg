import test from 'node:test';import assert from 'node:assert/strict';
import {minicampCommand} from '../src/minicamp/client.ts';
test('cup commands are routed separately from resenha',()=>{
 for(const t of ['!supabase','!teste','!jornada','!jornada Nome completo','!arquivo 2','!vistoria','!titulo','!título Nome completo','!titulo Nome completo','!comandos','!chave','!chave A','!chave B','!lado A','!cadastrar @Maria','!editar @Maria | Maria Souza','!excluir @Maria','!meunome Novo nome','!confronto Arthur x Lucas','!forçar resultado 123 4x3','!novacopa','!nome Copa Nova','!categoria seleção','!formato 4','!jogos 1','!abrircopa','!entrar','!sorteio','!sorteio Samuel','!sorteio Rafael | Seleção indisponível','!resultado 432 3x2','!confirmar 432','!stats','!ajuda','2'])assert.equal(minicampCommand(t),true);
 for(const t of ['!bot gs x amerio','bom dia','!entraroutra','25'])assert.equal(minicampCommand(t),false);
});
