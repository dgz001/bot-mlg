import test from 'node:test';
import assert from 'node:assert/strict';
import {cupQuestion} from '../src/minicamp/question.ts';

test('perguntas diretas consultam os jogos reais',()=>{
 for(const question of ['Quem será meu próximo adversário?', 'Quem eu vou pegar se eu passar de fase?', 'Qual meu próximo jogo?', 'Quando eu vou enfrentar o adversário?'])assert.equal(cupQuestion(question),'!meujogo');
 assert.equal(cupQuestion('Como está a Copa?'),'!copa');
 for(const question of ['Estou inscrito na Copa?', 'Tem placar pendente para mim?', 'Meu resultado já foi confirmado?', 'Quais jogos estão acontecendo?'])assert.equal(cupQuestion(question),question.startsWith('Quais')?'!copa':'!meujogo');
 for(const question of ['Como confirmo meu resultado?', 'Onde envio o print da partida?', 'Quais são os comandos para participar?'])assert.equal(cupQuestion(question),'!ajuda');
});
test('explicações, citações e comentários não disparam respostas',()=>{
 for(const text of ['Eu disse que quem será meu próximo adversário?', 'Ele perguntou quem é meu próximo adversário?', 'O José falou que vai pegar a Itália', '> Quem será meu próximo adversário?', '!resultado 123 3x2', 'Meu próximo adversário é o Rafael.', 'Quem ganha a Copa?', 'Se passar de fase, eu vou jogar amanhã.', 'Quem está inscrito na Copa?', 'Como está a situação do Rafael?'])assert.equal(cupQuestion(text),null,text);
});
