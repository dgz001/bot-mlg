# Controle operacional

O painel continua no endereço do bot. A senha existente continua válida.

- **Ligar bot**: retoma as respostas e a fila que ficou salva.
- **Desligar bot**: pausa respostas em todos os grupos e entrega de resultados pendentes; não exclui torneios, sessão ou estatísticas. Comandos novos enviados durante a pausa são ignorados. Um envio já iniciado pode terminar.
- **Reiniciar bot**: encerra o processo WhatsApp com até 15 segundos de tolerância, inicia um substituto e carrega novamente a sessão cifrada e os controles. Não liga automaticamente um bot pausado. Requer senha e tem intervalo mínimo de 60 segundos.
- **Acordar / verificar bot**: solicita o endpoint de prontidão; pode acordar uma instância gratuita adormecida. Não altera configuração.

O processo do painel supervisiona um único processo WhatsApp. Ausência de heartbeat por 30 segundos inicia recuperação; falhas de processo usam espera crescente. O substituto só é criado depois que o processo anterior termina. Reinício não é logout e não apaga credenciais. Se o WhatsApp revogar a sessão, será necessário novo pareamento pelo próprio titular.

O painel também permite ligar/desligar Resenha e Minicamp separadamente, autorizar grupos, selecionar ADMs e revisar memórias. Configurações são persistidas no cofre cifrado; Copas e resultados continuam no PostgreSQL.

Limite: supervisor e bot estão na mesma hospedagem gratuita. Uma indisponibilidade do Render inteiro, suspensão da conta ou perda de rede pode deixar ambos inacessíveis. Não é failover externo nem garantia de 100% de disponibilidade.

## Testes de banco

`npm run test:isolated` executa PostgreSQL temporário local em ambiente não root. `npm test` usa esse modo automaticamente no build do Render. Nenhuma credencial ou dado de produção é passado aos testes. Cada teste de integração cria e remove seu próprio banco. Os testes recriam os papéis NOLOGIN e aplicam as migrations necessárias antes do cadastro explícito do ADM de teste.

Não rode a suíte com credenciais de produção. Em CI com PostgreSQL próprio e descartável, use MLG_TEST_DATABASE_URL. Os quatro cenários são: Copa completa + retomada + duplicidade; sessão cifrada; rollback sem inscrição parcial; constraints e permissões de confirmação.
