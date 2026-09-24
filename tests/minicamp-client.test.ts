import test from 'node:test';import assert from 'node:assert/strict';
import {minicampCommand} from '../src/minicamp/client.ts';
test('cup commands are routed separately from resenha',()=>{
 for(const t of ['!supabase','!teste','!jornada','!jornada Nome completo','!arquivo 2','!vistoria','!titulo','!título Nome completo','!titulo Nome completo','!comandos','!confronto Arthur x Lucas','!forçar resultado 123 4x3','!novacopa','!formato 4','!entrar','!resultado 432 3x2','!confirmar 432','!stats','!ajuda','2'])assert.equal(minicampCommand(t),true);
 for(const t of ['!bot gs x amerio','bom dia','!entraroutra','25'])assert.equal(minicampCommand(t),false);
});
