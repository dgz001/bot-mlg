# Controle operacional

O painel continua no endereço do bot. A senha existente continua válida.

- **Ligar bot**: retoma as respostas e a fila que ficou salva.
- **Desligar bot**: pausa respostas em todos os grupos e entrega de resultados pendentes; não exclui torneios, sessão ou estatísticas. Comandos novos enviados durante a pausa são ignorados. Um envio já iniciado pode terminar.
- **Reiniciar bot**: encerra o processo WhatsApp com até 15 segundos de tolerância, inicia um substituto e carrega novamente a sessão cifrada e os controles. Não liga automaticamente um bot pausado. Requer senha e tem intervalo mínimo de 60 segundos.
- **Acordar / verificar bot**: solicita o endpoint de prontidão; pode acordar uma instância gratuita adormecida. Não altera configuração.

O processo do painel supervisiona um único processo WhatsApp. Ausência de heartbeat por 30 segundos inicia recuperação; falhas de processo usam espera crescente. O substituto só é criado depois que o processo anterior termina. Reinício não é logout e não apaga credenciais. Se o WhatsApp revogar a sessão, será necessário novo pareamento pelo próprio titular.

O painel também permite ligar/desligar Resenha e Minicamp separadamente, autorizar grupos, selecionar ADMs e revisar memórias. Configurações são persistidas no cofre cifrado; Copas e resultados continuam no PostgreSQL.

## Moderação na central dos ADMs

Selecione o grupo da Copa com `!grupos` e `!usar número`. Os ADMs cadastrados podem usar `!bloquear telefone | motivo`, `!desbloquear telefone | motivo` e `!bloqueados`. Informe o número completo com DDI e DDD. O bloqueio impede novos comandos de Copa e resenha em todos os grupos e registra a conta, o ADM e o motivo. A conta precisa estar presente no grupo selecionado ao bloquear. Para não deixar um confronto sem participante, substitua primeiro qualquer membro inscrito em Copa ativa. Retire a permissão de ADM no painel antes de bloquear outro ADM.

Esses comandos dependem da migração `015_member_blocks.sql` no banco do Minicamp e de uma versão compatível da função `mlg-bot-minicamp`. Faça a migração antes de atualizar a função e o worker. Não publique o worker isoladamente: ele consulta a função para aplicar o bloqueio à resenha.

O `!resultado` já rejeita uma segunda proposta para o mesmo jogo enquanto o placar está pendente; `!confirmar` não avança uma partida confirmada outra vez. Em caso de erro, `!contestar código` suspende a classificação, `!resolver código placar motivo` decide a contestação e `!forcarresultado código placar motivo` corrige uma partida, com auditoria. Confira o código e o print antes da intervenção.

Limite: supervisor e bot estão na mesma hospedagem gratuita. Uma indisponibilidade do Render inteiro, suspensão da conta ou perda de rede pode deixar ambos inacessíveis. Não é failover externo nem garantia de 100% de disponibilidade.

## Testes de banco

`npm run test:isolated` executa PostgreSQL temporário local em ambiente não root. `npm test` usa esse modo automaticamente no build do Render. Nenhuma credencial ou dado de produção é passado aos testes. Cada teste de integração cria e remove seu próprio banco. Os testes recriam os papéis NOLOGIN e aplicam as migrations necessárias antes do cadastro explícito do ADM de teste.

Não rode a suíte com credenciais de produção. Em CI com PostgreSQL próprio e descartável, use MLG_TEST_DATABASE_URL. Os quatro cenários são: Copa completa + retomada + duplicidade; sessão cifrada; rollback sem inscrição parcial; constraints e permissões de confirmação.
