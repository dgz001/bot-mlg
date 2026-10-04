export function loanPhone(value:string):string|null {
 if(!/^\+?[\d\s().-]+$/.test(value))return null;
 const phone=value.replace(/\D/g,'');
 return /^\d{10,15}$/.test(phone)?phone:null;
}
export function loanCommand(text:string):string {
 return text.replace(/^!(emprestar|empréstar|emprestimo|empréstimo|campeões|histórico|próximafase|forçarresultado)(?=\s|$)/i,command=>command.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase())
  .replace(/^!(dar|tirar)\s+adm(?=\s|$)/i,(_,verb:string)=>'!'+verb.toLowerCase()+'adm');
}
export const loanGuide=`🤝 GUIA DO ORGANIZADOR · BOT MLG
Seu número foi liberado para organizar campeonatos no seu grupo.

PRIMEIRO, PREPARE O GRUPO
1. Adicione este bot ao grupo do campeonato no WhatsApp e me dê acesso como administrador do grupo para acompanhar e enviar os avisos.
2. Você também precisa ser administrador desse grupo com o mesmo número que recebeu este convite.
3. Configure aqui no privado com !configbot. Faço poucas perguntas e mostro a revisão final para você confirmar ou rejeitar. Depois use !alterarconfig para mudar uma opção. Os comandos individuais continuam disponíveis.
4. No grupo em que quer disputar, envie !novacopa. Eu ativo o empréstimo nesse grupo e publico a configuração confirmada com inscrições abertas.
5. Os jogadores usam !entrar. Quando as vagas se completarem, eu anuncio os confrontos, marco os inscritos e explico os resultados.

CONFIGURE AQUI NO PRIVADO (OU DIRETAMENTE NO GRUPO)
!nome Nome do campeonato
Escolha !modalidade liga (pontos corridos), !modalidade copa (mata-mata) ou !modalidade misto (liga e depois mata-mata).
!vagas N — liga ou misto: 2 a 32 jogadores; copa: 4, 8, 16 ou 32. No misto, use !classificados 8 para avançar os oito primeiros (também aceita 4 ou 16, sempre menos que as vagas).
!jogos 1 — jogo único; !jogos 2 — ida e volta.
!equipes Time A | Time B | Time C | ... — ou um time por linha. Envie pelo menos um time diferente por vaga; os times serão sorteados.
!imagemgrupo — se quiser usar a foto atual do seu grupo nos anúncios. !imagemtexto deixa os anúncios só em texto. As artes MLG são exclusivas da comunidade MLG.
No privado: !revisar para conferir, !confirmar para guardar. Depois !novacopa no grupo publica.
No grupo: !revisar para conferir, !abrircopa para abrir as inscrições.

DURANTE O CAMPEONATO
!copa — jogos e códigos; !meujogo — sua próxima partida.
!jogo CÓDIGO — consultar uma partida.
!tabela — classificação de pontos corridos; !proximafase — próximos jogos.
!resultado CÓDIGO MxV — use o número # da partida exibido em !copa ou !meujogo; M é o gol do mandante, V é o gol do visitante. Compartilhe o print no grupo; o bot não lê o print.
O adversário confirma: !confirmar CÓDIGO MxV. Sem contestação, confirma automaticamente após cinco minutos.
!contestar CÓDIGO — adversário discorda; suspende a confirmação automática.
!cancelar CÓDIGO — quem enviou pode retirar um placar ainda pendente e reenviar.
Organizador: !forcarresultado CÓDIGO MxV motivo — corrigir o jogo pelo mesmo código, com motivo de pelo menos oito caracteres. Jogos posteriores com placar podem impedir a correção.
!campeoes ou !historico — campeões deste grupo.

AJUSTES E AJUDA
!painel — guia do organizador; !central — situação do campeonato.
Antes de abrir: altere a configuração e use !revisar novamente.
!adicionar Time A | Time B — acrescentar; !corrigirclubes Nome antigo | Nome correto — corrigir; !remover Nome do time — retirar; !times [página] — conferir a lista por partes.
Não há limite fixo de clubes: envie a lista em partes se for longa. Altere antes de !abrircopa e depois envie !revisar novamente.
!daradm telefone — liberar um administrador do WhatsApp como auxiliar somente neste grupo; !tiraradm telefone — revogar; !adms — conferir. Só o organizador principal altera auxiliares.
!descartar — apagar só o preparo.
!cancelarcopa motivo — cancelar a edição ativa; campeões anteriores ficam no histórico.
Liga: vitória vale 3 pontos, empate 1. No misto, após todos os jogos da liga, os melhores avançam conforme !classificados; desempate na tabela: pontos, saldo de gols, gols marcados, vitórias e nome. O mata-mata começa com 1º × último classificado, 2º × penúltimo e assim por diante. Ida e volta soma os gols; empate na decisão gera desempate. O bot anuncia o campeão ao encerrar.

Seu acesso vale somente para o grupo emprestado. A administração geral da MLG libera ou encerra o empréstimo.
Este privado aceita somente os comandos de configuração indicados. Ninguém acompanha este chat como atendimento humano; para ajuda fora desses comandos, procure os ADMs da MLG pelos canais habituais.`;
