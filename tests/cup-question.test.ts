import test from 'node:test';
import assert from 'node:assert/strict';
import {cupQuestion} from '../src/minicamp/question.ts';

test('perguntas diretas consultam os jogos reais',()=>{
 for(const question of ['Quem será meu próximo adversário?', 'Quem eu vou pegar se eu passar de fase?', 'Qual meu próximo jogo?', 'Quando eu vou enfrentar o adversário?'])assert.equal(cupQuestion(question),'!meujogo');
 assert.equal(cupQuestion('Como está a Copa?'),'!copa');
});
test('explicações, citações e comentários não disparam respostas',()=>{
 for(const text of ['Eu disse que quem será meu próximo adversário?', 'Ele perguntou quem é meu próximo adversário?', 'O José falou que vai pegar a Itália', '> Quem será meu próximo adversário?', '!resultado 123 3x2', 'Meu próximo adversário é o Rafael.', 'Quem ganha a Copa?', 'Se passar de fase, eu vou jogar amanhã.'])assert.equal(cupQuestion(text),null,text);
});
