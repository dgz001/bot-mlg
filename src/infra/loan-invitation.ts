export function loanPhone(value:string):string|null {
 if(!/^\+?[\d\s().-]+$/.test(value))return null;
 const phone=value.replace(/\D/g,'');
 return /^\d{10,15}$/.test(phone)?phone:null;
}
export function loanCommand(text:string):string {
 return text.replace(/^!(emprestar|empréstar|emprestimo|empréstimo)(?=\s|$)/i,command=>command.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase());
}
export const loanGuide=`🤝 GUIA DO ORGANIZADOR · BOT MLG
Seu número foi liberado para organizar campeonatos no seu grupo. Peça que adicionem o bot e confira se você é administrador do grupo.

CONFIGURE NO SEU GRUPO, NÃO NESTE PRIVADO
1. !novacopa — ativa o empréstimo e começa o preparo.
2. !nome Nome do campeonato
3. Escolha !modalidade liga (pontos corridos) ou !modalidade copa (mata-mata).
4. !vagas N — liga: 2 a 16 jogadores; copa: 4, 8, 16 ou 32. As fases do mata-mata seguem a quantidade de vagas.
5. !jogos 1 — jogo único; !jogos 2 — ida e volta.
6. !equipes Time A | Time B | Time C | ... — ou um time por linha. Envie pelo menos um time diferente por vaga; os times serão sorteados.
7. !imagemgrupo — se quiser usar a foto atual do seu grupo nos anúncios. !imagemtexto deixa os anúncios só em texto. As artes MLG são exclusivas da comunidade MLG.
8. !revisar — confira nome, modalidade, vagas, jogos e times.
9. !abrircopa — depois da revisão abre as inscrições. Cada jogador envia !entrar; ao lotar, o bot sorteia os confrontos.

DURANTE O CAMPEONATO
!copa — jogos e códigos; !meujogo — sua próxima partida.
!jogo CÓDIGO — consultar uma partida.
!tabela — classificação de pontos corridos; !proximafase — próximos jogos.
!resultado CÓDIGO MxV — gols do mandante primeiro, visitante depois. Compartilhe o print no grupo; o bot não lê o print.
O adversário confirma: !confirmar CÓDIGO MxV. Sem contestação, confirma automaticamente após cinco minutos.
!contestar CÓDIGO — adversário discorda; suspende a confirmação automática.
!cancelar CÓDIGO — quem enviou pode retirar um placar ainda pendente e reenviar.
Organizador: !forcarresultado CÓDIGO MxV motivo — corrigir com motivo de pelo menos oito caracteres. Jogos posteriores com placar podem impedir a correção.
!campeoes ou !historico — campeões deste grupo.

AJUSTES E AJUDA
!painel — guia do organizador; !central — situação do campeonato.
Antes de abrir: altere a configuração e use !revisar novamente.
!adicionar Time A | Time B — acrescentar; !corrigirclubes Nome antigo | Nome correto — corrigir; !remover Nome do time — retirar; !times [página] — conferir a lista por partes.
Não há limite fixo de clubes: envie a lista em partes se for longa. Altere antes de !abrircopa e depois envie !revisar novamente.
!daradm telefone — liberar um administrador do WhatsApp como auxiliar somente neste grupo; !tiraradm telefone — revogar; !adms — conferir. Só o organizador principal altera auxiliares.
!descartar — apagar só o preparo.
!cancelarcopa motivo — cancelar a edição ativa; campeões anteriores ficam no histórico.
Liga: vitória vale 3 pontos, empate 1. Mata-mata de ida e volta soma os gols. Empate na decisão gera desempate. O bot anuncia o campeão ao encerrar.

Seu acesso vale somente para o grupo emprestado. A administração geral da MLG libera ou encerra o empréstimo.
Este privado envia orientações automáticas. O bot não processa respostas aqui e não há atendimento humano acompanhando este chat. Para ajuda, procure os ADMs da MLG pelos canais habituais.`;
