import {createHash,randomInt} from 'node:crypto';
export type Coach={club:string;name:string;aliases:string[]};
const norm=(s:string)=>s.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
export function loadRoster(raw:string|undefined):Coach[]{
 if(!raw)return [];
 const list:unknown=JSON.parse(raw);
 if(!Array.isArray(list)||list.length>100||!list.every(c=>c&&typeof c.club==='string'&&typeof c.name==='string'&&Array.isArray(c.aliases)&&c.aliases.every((a:unknown)=>typeof a==='string')))throw Error('Invalid roster configuration');
 return list;
}
export function resolveCoach(input:string,roster:Coach[]):Coach[]{
 const q=' '+norm(input)+' ';
 const matches=roster.map(c=>({c,score:Math.max(0,...[c.club,c.name,...c.aliases].map(a=>{const n=norm(a);return n&&q.includes(' '+n+' ')?n.length:0;}))}));
 const best=Math.max(0,...matches.map(m=>m.score));
 return best?matches.filter(m=>m.score===best).map(m=>m.c):[];
}
export function matchupReply(text:string,roster:Coach[],group:string,choose:(options:string[])=>string=options=>options[randomInt(options.length)]!):string|null {
 const q=norm(text);
 if(!/\bquem (ganha|vence|leva)\b/.test(q)&&! /\s+(?:x|vs|versus|contra)\s+/.test(q))return null;
 if(!roster.length)return 'Ainda não tenho a lista de técnicos configurada. 🎮';
 const cleaned=q.replace(/\bquem (ganha|vence|leva)\b/g,' ').replace(/\bentre\b/g,' ').trim();
 const sides=cleaned.split(/\s+(?:x|vs|versus|ou|contra)\s+/);
 if(sides.length!==2)return 'Manda os dois lados: !bot Porto x Juventus quem ganha? 🍿';
 const a=resolveCoach(sides[0]!,roster),b=resolveCoach(sides[1]!,roster);
 if(a.length!==1||b.length!==1){
  const ambiguous=[...a,...b];
  return 'Qual técnico? Use o clube ou o nome completo'+(ambiguous.length?' — '+[...new Set(ambiguous.map(c=>c.name+' ('+c.club+')'))].join(', '):'')+'. 🎮';
 }
 if(a[0]===b[0])return 'É o mesmo técnico dos dois lados 😂 Manda outro adversário.';
 const pair=[a[0]!,b[0]!].sort((x,y)=>x.club.localeCompare(y.club));
 // Entertainment only: stable daily pick, not a ranking, result or inferred statistic.
 const seed=createHash('sha256').update(JSON.stringify([group,new Date().toISOString().slice(0,10),pair.map(c=>c.club)])).digest()[0]!;
 const pick=pair[seed%2]!;
 const lines=[
 'Meu chute de resenha: {pick}! Quem discordar pode resolver no controle 😂',
 'Vou de {pick}, no palpite! O outro lado já pode preparar a cobrança 🍿',
 'Palpite sem VAR: {pick}. Se der errado, essa mensagem veio sem garantia 😂',
 'Hoje meu chute é {pick}. O jogo de verdade é que vai dar a resposta 🎮',
 'Na resenha eu escolho {pick}. A bola não assinou esse palpite comigo 😂',
 'Meu palpite é {pick}! Quero ver quem aparece primeiro no pós-jogo.',
 'Chute do bot: {pick}. Não vale usar isso como palestra motivacional 😂',
 'Vou arriscar {pick}! Agora falta avisar o adversário que eu dei palpite 🍿',
 'Palpite de arquibancada: {pick}. O controle continua mandando mais que eu.',
 'Pra movimentar a resenha: {pick}! Pode guardar o print e cobrar depois 😂',
 'Meu chute vai em {pick}. Favoritismo aqui vem sem certificado.',
 'Apostei meu prestígio imaginário em {pick}. É só palpite, calma 😂',
 'Meu palpite: {pick}! Quem perder esse chute já pode rir da minha análise.',
 'Vou de {pick}, só na brincadeira. A coletiva tá aberta pros dois 🍿',
 'No meu chute dá {pick}! No campo vocês resolvem sem consultar o robô.',
 'Palpite lançado: {pick}. Já deixei espaço pra uma nota de retratação 😂',
 'Se é pra dar pitaco, vou de {pick}! O replay que me julgue.',
 'Meu chute: {pick}. Agora encerra a enquete e abre a sala 🎮',
 'Vou palpitar {pick}! A única certeza é que esse grupo vai comentar.',
 'Na mesa da resenha deu {pick}. No console ainda precisa jogar 😂',
 'Chute sem estatística inventada: {pick}! Me cobrem no apito final.',
 'Meu palpite vai pra {pick}. O adversário ganhou combustível de graça 🍿',
 'Eu chuto {pick}! Mas não fui contratado pra defender esse palpite no tribunal 😂',
 'Pra essa chamada, vou de {pick}. É pitaco, não resultado antecipado.',
 'Meu palpite é {pick}. Já imagino o print voltando se eu errar 😂',
 'Vou de {pick}! Chute de resenha não vem com cláusula de reembolso.',
 'No achismo esportivo: {pick}! A confirmação só sai jogando 🎮',
 'Meu chute aponta {pick}. Não contem pro outro lado que eu quero assistir em paz 😂',
 'Palpite do dia: {pick}. A coletiva de quem discordar começa agora 🍿',
 'Vou arriscar {pick}. Se o contrário acontecer, o grupo ganhou mais um pra zoar 😂',
 'Meu chute é {pick}! Mas o botão de iniciar vale mais que esse discurso.',
 'Deixo meu palpite em {pick}. Agora tragam futebol, porque discussão já tem 😂'
 ];
 return `${a[0]!.name} (${a[0]!.club}) x ${b[0]!.name} (${b[0]!.club})\n${choose(lines).replaceAll('{pick}',pick.name)}`;
}
