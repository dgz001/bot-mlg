import {loadRoster,matchupReply} from './matchup.ts';
import {randomInt} from 'node:crypto';
const banks = {
 defeat: ['Nem começou e tu já tá preparando a coletiva de desculpas 😂','Entra em campo primeiro, a entrevista do eliminado é depois 😂','Calma, ainda dá tempo de surpreender até essa tua previsão 🎮'],
 market: ['Fechou o elenco ou só fechou a aba do mercado? 😂','Nesse ritmo o contrato vem com período de teste de quinze minutos 😂','O empresário já deixou o carregador na sede do clube 📱😂'],
 complaints: ['O apito final tocou e a perícia do controle começou 😂','Vai ter mais análise desse jogo do que treino pra próxima partida 🍿','A coletiva promete prorrogação hoje 😂'],
 victory: ['Já tô vendo: noventa minutos de jogo e três dias de resenha 🍿','Ganhou o jogo e desbloqueou o pacote de entrevistas 😂','O pós-jogo desse grupo devia ter transmissão própria 🍿'],
 escape: ['A velocidade apareceu justamente na hora de fugir do confronto 😂','Essa arrancada fora do campo precisa entrar nos melhores momentos 😂'],
 general: ['Manda o lance: foi futebol ou já estamos na coletiva? 😂','Nesse grupo até o amistoso precisa de assessoria de imprensa 🍿','Tô acompanhando. O futebol é no console, o segundo tempo é aqui 😂']
};
type Topic=keyof typeof banks;
export function topicFor(text:string):Topic {
 const t=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 if(/\b(vou perder|vamos perder|ja perdi)\b/.test(t))return 'defeat';
 if(/\b(mercado|elenco|contratar|contratacao|comprar|vender|proposta)\b/.test(t))return 'market';
 if(/\b(chorando|chorao|reclamando|lag|roubado|desculpa)\b/.test(t))return 'complaints';
 if(/\b(ganhou|ganhei|venceu|venci|vitoria)\b/.test(t))return 'victory';
 if(/\b(fugir|fugiu|medo|arregou)\b/.test(t))return 'escape';
 return 'general';
}
// Only transient reply selection; no claims about people or stored factual memory.
export function createBanterReply(){
 const roster=loadRoster(process.env.MLG_ROSTER_JSON);
 const previous=new Map<string,string>();
 return (group:string,text:string)=>{
  const matchup=matchupReply(text,roster,group);if(matchup)return matchup;
  const options=banks[topicFor(text)].filter(x=>x!==previous.get(group));
  const answer=options[randomInt(options.length)]!;
  if(previous.size>=1000&&!previous.has(group))previous.delete(previous.keys().next().value!);
  previous.set(group,answer);return answer;
 };
}
