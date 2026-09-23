# Carreira e identidade na Arena MLG

Comandos públicos:
- `!carreira`: seu perfil. Aceita nome completo ou uma menção real a uma conta.
- `!moral [página]`: classificação, dez técnicos por página.
- `!participantes [ID da Copa]`: inscritos e clubes; sem ID, Copa ativa ou mais recente do grupo.

Comandos dos ADMs explicitamente selecionados no painel:
- `!registrar Nome do técnico | @conta`: cadastro do nome, com uma menção real a membro do grupo.
- `!associar Nome do técnico | @conta`: atualiza o nome da mesma conta; não transfere nem funde históricos.
- `!sincronizarcontas`: confere até 100 membros com cadastros/participações no grupo e adiciona somente pares PN/LID comprovados pelo WhatsApp. Contas conflitantes ficam intactas. Não migra dados de outro bot nem deduz identidade por nome.
- `!revisarnumeros`: reconstrói e resume as carreiras pelas partidas confirmadas. Não há contadores acumulados para zerar; cada consulta refaz o cálculo.

Pontuação: título 100, vice 40, vitória 5, empate 2, cada jogo do recorde invicto 2 e do recorde de vitórias 2. Bônus únicos: primeira taça 10; cinco vitórias consecutivas 15; dez jogos invicto 25. Desempate: títulos, vitórias, identificador estável. A ordem exibida não muda aleatoriamente.

Resultados pendentes/disputados e Copas canceladas não contam. Revisões contam uma única vez, com o último placar confirmado e a posição cronológica original. W.O. conta como 3x0, conforme a regra atual. Mata-mata exige resultado decisivo; empates só serão contabilizados se houver resultados históricos confirmados com esse status esportivo.

Rivalidades mostram saldo positivo/negativo de vitórias nos confrontos registrados. Empate não produz freguês nem carrasco. Ausência de histórico não vira informação inventada.

Cadastro preserva IDs canônicos, partidas, conquistas e nomes históricos nas súmulas. O nome cadastrado aparece na carreira e nas inscrições futuras. Homônimos devem ser consultados por menção; nomes de outra conta não podem ser apropriados. Permissão de ADM nunca depende do nome cadastrado.

Migração 010 é aditiva, no schema privado mlg_bot. Perfis têm permissão somente para o gateway de backend. Alterações cadastrais têm auditoria, deduplicação e transação junto da resposta. A execução Supabase usa o gateway privado; os arquivos de sessão e tokens nunca entram no repositório.
