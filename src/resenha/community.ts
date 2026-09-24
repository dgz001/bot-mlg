import {chooseReply,type ReplyHistory} from './variety.ts';

// Curated themes from the supplied Resenha export. These are running jokes,
// never official results or claims about someone's private life.
const lore=[
 {match:/\bvan\b/i,lines:[
  'O Van aparece na conversa e a janela de transferências abre sozinha 😂 Vai ter reforço ou só suspense?',
  'Se o assunto é Van, alguém já está preparando uma proposta de última hora. No campo ainda precisa jogar 🍿',
  'Van e negociação no mesmo assunto? O grupo já procura a calculadora e a pipoca.'
 ]},
 {match:/\barthur\b/i,lines:[
  'Arthur entrou no papo e a zaga já pediu direito de resposta 😂 Como foi o jogo?',
  'Com Arthur a resenha costuma chegar antes do apito. A zaga vai sobreviver à coletiva? 🍿',
  'Vai falar do Arthur? Então chama a defesa também, porque ela sempre acaba na entrevista 😂'
 ]},
 {match:/\bfernando\b|\bguirassy\b/i,lines:[
  'Fernando e Guirassy no mesmo assunto deixam qualquer prancheta nervosa 🎮 Quem encara?',
  'O grupo já fez campanha pelo Guirassy. Agora quero ver a escalação entrar em campo 🍿',
  'A carta do Fernando virou assunto de arquibancada. O placar, só depois do jogo.'
 ]},
 {match:/\banderson\b.*\binternet\b|\binternet\b.*\banderson\b/i,lines:[
  'A conexão do Anderson virou personagem da resenha 😂 Combinem a sala e confiram o ping antes do jogo.',
  'Anderson, se esta mensagem chegar a tempo, já dá pra marcar a partida? 📶😂',
  'O confronto promete. O roteador também foi convocado para se apresentar 🎮'
 ]},
 {match:/\bam[eé]rio\b/i,lines:[
  'Amério apareceu e o mercado já quer saber qual é a próxima proposta 😂',
  'Se o assunto é Amério, alguém vai conferir o preço de cada carta antes do amistoso 🍿',
  'A prancheta é uma coisa, as negociações são outra. Qual vai ser a jogada do Amério?'
 ]},
 {match:/\bporto\b/i,lines:[
  'Porto apareceu na resenha e já tem gente revendo o palpite. Mata-mata só se decide no controle 🍿',
  'O Porto já rendeu conversa de azarão na liga. Quem vai bancar o palpite dessa vez?',
  'Falar do Porto antes do jogo é fácil. Quero ver depois do apito 🎮'
 ]},
 {match:/\batalanta\b/i,lines:[
  'Atalanta entra na conversa e todo mundo vira analista tático 😂 Como vem a escalação?',
  'A Atalanta já deu assunto para a arquibancada. Agora deixa o jogo contar a história 🍿',
  'Atalanta no confronto? A resenha já começou, mas o resultado ainda precisa do controle.'
 ]}
] as const;

export function communityReply(group:string,text:string,history:ReplyHistory):string|null {
 const topic=lore.find(t=>t.match.test(text));
 return topic?chooseReply(group,[...topic.lines],history):null;
}
