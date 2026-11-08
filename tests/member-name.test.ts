import test from 'node:test';
import assert from 'node:assert/strict';
import {memberName} from '../src/minicamp/member-name.ts';
import {memberCommand} from '../src/minicamp/member-commands.ts';

test('o nome não deve ser confundido com o identificador numérico da menção',()=>{
 assert.equal(memberName(' @Maria  da Silva '),'Maria da Silva');
 assert.equal(memberName('@@João\n de   Souza'),'João de Souza');
 for(const value of ['@','@5511999999999','@João | outra conta'])assert.throws(()=>memberName(value),/Nome inválido/);
 assert.equal(memberName('@Maria\u202eX'),'MariaX');
});

test('comandos usam o JID selecionado e recebem o nome fora do token de menção',()=>{
 assert.equal(memberCommand('!cadastrar @5511999999999 | Maria Souza','member-123'),'!cadastrarid member-123 Maria Souza');
 assert.equal(memberCommand('!excluir @5511999999999','member-123'),'!excluirid member-123');
 assert.equal(memberCommand('!editar @5511999999999 | Maria da Silva','member-123'),'!editarid member-123 Maria da Silva');
 assert.equal(memberCommand('!registrar Maria Souza | @5511999999999','member-123'),'!registrarid member-123 Maria Souza');
 assert.equal(memberCommand('!associar João Pereira | @5511999999999','member-123'),'!associarid member-123 João Pereira');
});

test('recusa nomes ausentes, números como nome e menção fora da posição esperada',()=>{
 assert.throws(()=>memberCommand('!cadastrar @5511999999999','member-123'),/Formato/);
 assert.throws(()=>memberCommand('!editar @5511999999999 |','member-123'),/Formato/);
 assert.throws(()=>memberCommand('!cadastrar Nome | @5511999999999','member-123'),/Formato/);
 assert.throws(()=>memberCommand('!registrar Maria Souza','member-123'),/Formato/);
 assert.throws(()=>memberCommand('!cadastrar @5511999999999 | @5511888888888','member-123'),/Nome inválido/);
 assert.throws(()=>memberCommand('!excluir @5511999999999 texto','member-123'),/Formato/);
});
