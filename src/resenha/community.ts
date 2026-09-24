import {chooseReply,type ReplyHistory} from './variety.ts';

// Themes curated from the supplied group export. No raw messages, phone numbers,
// private-life claims or unverified match results belong in this reply bank.
const lore=[
 {match:/\bgs\b.*\bamerio\b|\bamerio\b.*\bgs\b/,lines:[
  'GS e Amério no mesmo papo? A coletiva já começou antes do amistoso 😂 Quem chama a sala?',
  'Essa conversa de GS e Amério sempre rende réplica e tréplica. No controle a história é outra 🍿',
  'GS contra Amério é daqueles assuntos que voltam no grupo. Manda o jogo, não só a provocação 🎮',
  'A arquibancada pediu GS x Amério. Placar de resenha não entra na tabela, combinado? 😂',
  'Pode provocar GS e Amério à vontade; resultado oficial só vem de partida confirmada 🏆',
  'Já vi essa dupla render conversa. Quem marcar a revanche avisa antes da coletiva 🍿'
 ]},
 {match:/\bgs\b/,lines:[
  'Chamaram o GS? A mesa da resenha já prepara o microfone pro pós-jogo 😂',
  'GS apareceu no assunto e a coletiva ganhou mais um capítulo. Qual foi o lance? 🍿',
  'Vai falar do GS? Traz o replay junto, porque a análise do grupo não termina cedo 😂',
  'O nome do GS sempre rende debate. O controle é que decide o próximo jogo 🎮',
  'GS tem direito a resposta na resenha e a revanche no campo 🍿'
 ]},
 {match:/\bvan\b/i,lines:[
  'O Van aparece na conversa e a janela de transferências abre sozinha 😂 Vai ter reforço ou só suspense?',
  'Se o assunto é Van, alguém já está preparando uma proposta de última hora. No campo ainda precisa jogar 🍿',
  'Van e negociação no mesmo assunto? O grupo já procura a calculadora e a pipoca.',
  'Perguntaram do Van e a janela já abriu na imaginação da turma 😂 Qual é a proposta?',
  'Se o Van chamou no privado, a arquibancada já acha que vem anúncio. Confirma no campo também 🎮'
 ]},
 {match:/\barthur\b/i,lines:[
  'Arthur entrou no papo e a zaga já pediu direito de resposta 😂 Como foi o jogo?',
  'Com Arthur a resenha costuma chegar antes do apito. A zaga vai sobreviver à coletiva? 🍿',
  'Vai falar do Arthur? Então chama a defesa também, porque ela sempre acaba na entrevista 😂',
  'Arthur virou assunto de liga? A resenha já escalou comentaristas antes do sorteio 🍿',
  'O Arthur entrou na conversa e a coletiva foi aberta. A resposta boa vem no controle 🎮'
 ]},
 {match:/\bronald\b/,lines:[
  'Ronald entrou no papo e a torcida já perguntou da Roma. Qual é a escalação de hoje? 🍿',
  'Com Ronald no assunto, a turma já começa a discutir elenco e carta. E o jogo, foi marcado? 🎮',
  'Ronald e Roma rendem conversa por aqui. Favoritismo se resolve jogando, não no grito 😂',
  'Chamaram o Ronald? Deixa o controle responder antes de atualizar a previsão da liga 🍿',
  'A resenha pode apostar no Ronald; taça registrada exige Copa concluída 🏆'
 ]},
 {match:/\beduardo\b/,lines:[
  'Eduardo na disputa? A torcida já quer palpite, mas primeiro marca a partida 🎮',
  'Chamaram o Eduardo pra conversa e a liga ganhou comentarista extra 😂',
  'Eduardo pode surpreender no controle. Palpite do chat ainda não é título 🍿',
  'Se a pergunta é sobre o Eduardo, quero ver a escalação antes da coletiva 🎮',
  'Eduardo entrou na resenha; agora é esperar o apito, não inventar placar 🏟️'
 ]},
 {match:/\brafa\s+santos\b/,lines:[
  'Rafa Santos apareceu na conversa e a arquibancada já quer previsão 😂 Quem é o adversário?',
  'Vai falar do Rafa Santos? Melhor abrir a sala: palpite bom é o que rende partida 🎮',
  'Rafa Santos na Copa sempre rende debate. O chaveamento é que conta o próximo capítulo 🍿',
  'Se o Rafa Santos for jogar, chama a turma pra assistir e depois vem a resenha 🏟️'
 ]},
 {match:/\bgaldino\b/,lines:[
  'Galdino entrou no papo? Já tem gente procurando o adversário pra comparar escalação 😂',
  'Quando citam o Galdino, a turma puxa mais um duelo pro debate. Bora marcar o jogo 🎮',
  'Galdino na resenha, controle carregado e coletiva a postos. Qual é o confronto? 🍿',
  'Com Galdino no assunto, o grupo vira mesa-redonda. Placar só depois do apito ⚽'
 ]},
 {match:/\bfernando\b|\bguirassy\b/i,lines:[
  'Fernando e Guirassy no mesmo assunto deixam qualquer prancheta nervosa 🎮 Quem encara?',
  'O grupo já fez campanha pelo Guirassy. Agora quero ver a escalação entrar em campo 🍿',
  'A carta do Fernando virou assunto de arquibancada. O placar, só depois do jogo.',
  'Quando o Fernando entra na conversa, o Guirassy também ganha manchete 😂 E a escalação?',
  'A carta do Fernando já rendeu debate suficiente pra uma prévia. Agora falta jogar 🎮'
 ]},
 {match:/\banderson\b.*\binternet\b|\binternet\b.*\banderson\b/i,lines:[
  'A conexão do Anderson virou personagem da resenha 😂 Combinem a sala e confiram o ping antes do jogo.',
  'Anderson, se esta mensagem chegar a tempo, já dá pra marcar a partida? 📶😂',
  'O confronto promete. O roteador também foi convocado para se apresentar 🎮',
  'Anderson, antes de abrir a sala, faz aquele teste de conexão que o grupo já conhece 😂',
  'A turma comenta da internet do Anderson; melhor conferir o ping e jogar sem susto 📶'
 ]},
 {match:/\bam[eé]rio\b/i,lines:[
  'Amério apareceu e o mercado já quer saber qual é a próxima proposta 😂',
  'Se o assunto é Amério, alguém vai conferir o preço de cada carta antes do amistoso 🍿',
  'A prancheta é uma coisa, as negociações são outra. Qual vai ser a jogada do Amério?',
  'Amério entrou na conversa e já apareceu gente querendo saber o valor da proposta 💰😂',
  'Amério pode negociar o dia inteiro; o próximo jogo ainda precisa de controle 🎮'
 ]},
 {match:/\bporto\b/i,lines:[
  'Porto apareceu na resenha e já tem gente revendo o palpite. Mata-mata só se decide no controle 🍿',
  'O Porto já rendeu conversa de azarão na liga. Quem vai bancar o palpite dessa vez?',
  'Falar do Porto antes do jogo é fácil. Quero ver depois do apito 🎮',
  'Porto rendendo debate outra vez? A torcida já abriu a mesa de palpites 🍿'
 ]},
 {match:/\batalanta\b/i,lines:[
  'Atalanta entra na conversa e todo mundo vira analista tático 😂 Como vem a escalação?',
  'A Atalanta já deu assunto para a arquibancada. Agora deixa o jogo contar a história 🍿',
  'Atalanta no confronto? A resenha já começou, mas o resultado ainda precisa do controle.',
  'A Atalanta entrou no sorteio da conversa. Favorito só se prova jogando 🎮'
 ]},
 {match:/\b(janela|mercado|negoci\w*|transfer\w*|leilao|carta|elenco)\b/,lines:[
  'Abriu a janela e o grupo vira escritório de empresário. Quem tá negociando agora? 😂',
  'Tem carta, troca e proposta na conversa? Parece pré-temporada da MLG 🍿',
  'Essa negociação já tem mais capítulos que o mata-mata. Cadê a confirmação do reforço? 😂',
  'Antes de fechar o elenco, alguém confere se ainda sobrou orçamento pro goleiro? 🎮',
  'Mercado animado por aqui. Contratação boa também tem que funcionar no controle ⚽',
  'O privado tá movimentado, mas a torcida quer ver a escalação em campo 🍿'
 ]}
] as const;

export function communityReply(group:string,text:string,history:ReplyHistory):string|null {
 const normalized=text.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 const topic=lore.find(t=>t.match.test(normalized));
 return topic?chooseReply(group,[...topic.lines],history):null;
}
