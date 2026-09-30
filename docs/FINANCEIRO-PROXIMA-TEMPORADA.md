# Financeiro virtual — próxima temporada

Implementação preparada e desligada. Não aplica migração no banco de produção, não cria saldo, não movimenta dinheiro real e não envia cobranças nesta temporada. O empréstimo do **bot** (`!emprestar telefone` / `!empréstimo telefone`) continua separado.

## Modelos

**Banco:** ADMs emitem saldo virtual para a reserva. Cada contrato confirmado debita a reserva e credita o membro; cada pagamento faz o caminho inverso. Pedido pendente não transfere nem reserva dinheiro. Na confirmação, saldo, limites e vencimentos são conferidos novamente. Aprovação pode ser manual (outro ADM aprova quando o solicitante também é ADM) ou automática pelas regras, sempre seguida do consentimento do solicitante.

**Pessoas:** o credor oferece seu próprio saldo a uma pessoa realmente marcada no grupo. Só essa pessoa pode aceitar o código, recebendo o valor e assumindo a obrigação registrada. Credor sem saldo não pode confirmar o empréstimo. Ambos os modelos podem coexistir ou ser usados separadamente.

Valores são unidades virtuais MLG com duas casas decimais, armazenadas como inteiros. `1.000,50` significa mil e cinquenta centésimos. Não há juros, multa, Pix, custódia ou integração automática com a economia da plataforma Vercel. Saldo inicial de membros é zero; ADMs podem alocar saldo e membros podem transferir entre si.

## Comandos e exemplo de configuração

Executar no grupo escolhido para empréstimos, **apenas após a liberação técnica na próxima temporada**:

```
!financeiro preparar T2027
!financeiro administracao 123456789@g.us
!financeiro regras 100000 100000 30 1 automatico
!financeiro alertas 1000000000 80
!adicionarsaldo 1000000000
!financeiro limite @membro 50000 50000 1
!financeiro ativar banco T2027
```

O ID de administração acima é exemplo. Cadastrar o grupo real autorizado com administradores configurados; conferir que contém somente os ADMs desejados. A reserva estará com 1.000.000.000,00 MLG. Limites gerais e individuais são combinados pelo mais restritivo. Na configuração acima, cada membro pode ter apenas uma proposta pendente ou dívida ativa. Pagamento parcial não libera uma segunda vaga até a quitação.

- `!banco pedir 50000 15`: solicitar 50.000 MLG por 15 dias.
- `!financeiro aprovar CÓDIGO`: ADM aprova quando o banco está no modo manual.
- `!sim CÓDIGO` / `!nao CÓDIGO`: confirmar ou recusar o contrato exato; `!sim` sozinho não confirma dinheiro.
- `!emprestardinheiro @pessoa 1000 15`: oferta entre pessoas, após habilitar `pessoas` ou `ambos`.
- `!financeiro pagar CÓDIGO 1000`: pagamento parcial ou integral com o saldo do devedor.
- `!financeiro transferir @pessoa 1000 Motivo da transferência`: usar o saldo; valor não pode ultrapassar o disponível.
- `!financeiro saldo`, `!financeiro extrato [página]`, `!financeiro dividas [página]`: consultas pessoais.
- `!financeiro relatorio [página]`: ADM consulta credor, devedor, contratos, devoluções e vencimentos.
- `!financeiro ranking [página]`: ADM vê membros ordenados pelo total tomado, quantidade de contratos e saldo devedor. Paginar permite comparar quem tomou mais e menos entre os participantes que contrataram.
- `!financeiro relatorio temporada T2027 [página]`: histórico de temporada encerrada; também funciona para extrato e dívidas.
- `!financeiro creditar @pessoa 1000 Motivo da alocação`: emissão administrativa para membro; sempre auditada.
- `!financeiro bloquear @pessoa Motivo da restrição` / `liberar`: impedir ou permitir novos contratos. Pagamentos continuam disponíveis.
- `!financeiro cancelar CÓDIGO`: cancelar proposta pendente; não apaga contrato confirmado.
- `!financeiro pausar T2027`: suspender novos contratos. Consultas, pagamentos e monitoramento continuam.
- `!financeiro encerrar T2027`: exige ausência de propostas e dívidas; preserva o histórico. Uma nova temporada começa com saldo zero.

Regras gerais só mudam enquanto o modelo está pausado. Prazos e valores de contratos confirmados não mudam retroativamente. Não há extensão, perdão ou cobrança automática de saldo: quitação precisa de comando do devedor.

## Alertas e privacidade

Em operação, o worker consulta a fila a cada 15 segundos. O monitor econômico percorre temporadas no máximo uma vez por hora e faz lembrete de vencimento uma vez por dia UTC por contrato, para o **privado do devedor** e para o **grupo administrativo**. Não publica dívida vencida no canal de empréstimos. Pedidos novos de uma conta com dívida vencida são recusados com mensagem genérica. Se o membro saiu do grupo, a entrega privada não é feita pelo worker; a administração ainda recebe sua mensagem.

O limiar de emissão diária avisa quando os créditos criados por ADMs atingem o valor configurado. O limiar percentual de utilização compara dívida do banco em aberto com dívida mais reserva disponível. Os avisos econômicos gerais chegam ao grupo de empréstimos e à administração sem expor um devedor; a conta associada à movimentação também recebe o aviso no privado. Recusas de novos contratos geram um aviso privado para a conta envolvida, além da resposta ao comando no canal. **Esses sinais não demonstram inflação:** medir inflação exige um histórico de preços, que o bot ainda não possui.

As mensagens têm fila persistente, identificação estável, tentativas e prazo de processamento. Falhas de entrega são repetidas até dez tentativas e depois ficam registradas como `failed`; isso exige acompanhamento operacional. O aceite de envio pelo WhatsApp não prova leitura. Com o bot pausado globalmente ou a hospedagem indisponível, alertas ficam atrasados até o serviço voltar.

## Persistência e liberação futura

Schema privado `mlg_finance`, separado das copas e do cofre WhatsApp. Livro de movimentos e eventos não aceitam alteração/exclusão pelo papel financeiro. Uma movimentação tem origem e destino no mesmo registro. Transações serializadas por grupo, confirmação única por contrato e recibos por mensagem protegem contra concorrência e repetição. Não há acesso pelo cliente público Supabase.

1. Validar novamente a versão candidata com `npm run typecheck` e `npm run test:isolated`.
2. Aplicar **somente na liberação futura** `supabase/migrations/20260930150109_finance_loans.sql` no projeto do bot. É a primeira migração nesse diretório; não equivale às versões 1–22 do diretório legado `migrations/`. Conferir o histórico remoto antes de qualquer `supabase db push`. O startup atual não aplica essa migração.
3. Preparar uma nova função Edge com `deploy/finance-gateway.ts` como `index.ts` e os arquivos `src/finance/{store,commands,money,reference}.ts` no mesmo diretório. Substituir `__DIGEST__` pelo SHA-256 da string completa `Bearer TOKEN_ALEATORIO`, usando segredo exclusivo de alta entropia, sem imprimir o token. Configurar `SUPABASE_DB_URL`, mantendo o papel financeiro privado.
4. Configurar os dois portões independentes: `FINANCE_ENABLED=true` na função e no worker, além de `FINANCE_URL` e `FINANCE_TOKEN` no worker. Não reutilizar token de sessão ou de copas. A função exige seu próprio token, mesmo quando o gateway Supabase não valida JWT.
5. Fazer teste com contas controladas: abastecimento, pedido, consentimento, pagamento parcial, quitação, concorrência, cobrança privada e destino administrativo. Depois preparar e ativar a temporada real com os comandos acima.

O código e `render.yaml` mantêm `FINANCE_ENABLED=false`. Não foi aplicada migração financeira nem publicada função financeira em produção. A hospedagem Render precisa estar operacional para que o bot e seus lembretes funcionem; a suspensão por faturamento identificada na revisão anterior é independente deste módulo.


## Base provisória da liga em 30/09/2026

Os 25 clubes e treinadores enviados pela administração estão em `src/finance/reference.ts`, com total líquido de **€977 milhões**. Mantém Bayer Leverkusen com **-€20 milhões** e **transfer ban**. Corrige apenas grafias dos clubes: Tottenham, Brighton, Bayern München e Beşiktaş. Nomes de treinadores são rótulos de referência; não inferem telefone, identidade nem papel de ADM.

Ao preparar uma temporada financeira no futuro, a lista é copiada como referência provisória separada das carteiras MLG. **Não importa saldos automaticamente para as carteiras** nem converte EUR em MLG. Depois da abertura da janela, a administração precisa decidir essa integração e confirmar a base. Uma nova temporada usa a referência inicial datada; os valores atuais da temporada anterior não são transportados automaticamente.

Comandos preparados para consultar e atualizar a base pelo bot após a liberação:

```
!financeiro equipes
!financeiro equipe juventus 54M Conferência antes da janela
!financeiro equipe bayer-leverkusen -20M Saldo final confirmado pela administração
!financeiro transferban bayer-leverkusen sim Penalidade para a próxima janela
!financeiro vincular @pessoa juventus
```

A atualização de saldo é **absoluta**, não uma soma: repetir `54M` mantém €54 milhões. Aceita `0`, negativos e valores completos, além de `M` para milhões; `54M` equivale a `54000000`. Transfer ban muda por comando próprio: quitar saldo negativo não retira a penalidade automaticamente. Os exemplos usam menções reais do WhatsApp, necessárias para vincular cada treinador; o texto colado com apelidos não identifica uma conta com segurança. Uma pessoa só pode estar vinculada a um clube por temporada. Os eventos guardam valores anteriores, novos valores, ADM, mensagem, data e motivo. Só ADMs gerais cadastrados podem alterar ou vincular. Esses comandos não concedem permissão administrativa aos nomes listados como ADM.
