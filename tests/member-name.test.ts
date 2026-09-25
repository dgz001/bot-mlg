import test from 'node:test';import assert from 'node:assert/strict';
import {memberName} from '../src/minicamp/member-name.ts';
import {memberCommand} from '../src/minicamp/member-commands.ts';
test('menção fornece somente o nome, sem símbolo, telefone ou caracteres de controle',()=>{
 assert.equal(memberName(' @Maria  da Silva '),'Maria da Silva');
 assert.equal(memberName('@@João\n de   Souza'),'João de Souza');
 for(const value of ['@','@5511999999999','@João | outra conta'])assert.throws(()=>memberName(value),/Nome inválido/);
 assert.equal(memberName('@Maria\u202eX'),'MariaX');
});
test('cadastro, exclusão e edição usam identidade real e nome limpo',()=>{
 assert.equal(memberCommand('!cadastrar @Maria Souza','member-123'),'!cadastrarid member-123 Maria Souza');
 assert.equal(memberCommand('!excluir @Maria Souza','member-123'),'!excluirid member-123');
 assert.equal(memberCommand('!editar @Maria Souza | Maria da Silva','member-123'),'!editarid member-123 Maria da Silva');
 assert.equal(memberCommand('!registrar Maria | @pessoa','member-123'),'!registrarid member-123 Maria');
 assert.throws(()=>memberCommand('!cadastrar @5511999999999','member-123'),/Nome inválido/);
});
