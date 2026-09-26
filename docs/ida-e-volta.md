# Modalidade de ida e volta: integração pendente

A regra pura em `src/minicamp/tie-rules.ts` calcula o agregado com o mando
invertido na volta. O primeiro jogo nunca classifica alguém; empate no agregado
aguarda pênaltis explícitos, sem critério de gol fora. Essa regra ainda **não é
chamada pelo bot**. A Copa do Mundo atual continua em jogo único.

Para ativar em novas Copas, a próxima mudança deve incluir **tudo** abaixo:

1. Migração com modalidade copiada do modelo para a Copa e registros duráveis de
   ida, volta e pênaltis; edições existentes recebem `single`.
2. Configuração no painel e na central dos ADMs antes da abertura. A escolha
   fica imutável após inscrições; qualquer alteração exige nova edição.
3. Placar e confirmação independentes por perna, sempre com o mandante visível.
   O banco serializa comandos concorrentes e deduplica cada ID de mensagem.
4. Só publicar classificado, adversário seguinte ou campeão depois da volta e,
   se necessário, dos pênaltis. Resultados corrigidos precisam revalidar a
   fase seguinte; nunca apagar automaticamente jogos já disputados.
5. Atualizar `!jogo`, `!copa`, `!chave`, retrospectos, estatísticas, auditoria,
   checkpoints e anúncios para mostrar ambos os placares e o agregado.
6. Testar com PostgreSQL isolado: empate de um jogo, virada na volta, empate no
   agregado, pênaltis, dois envios simultâneos, correção e reinício entre jogos.

Manter o modo novo desligado até a migração, as mensagens e esses testes
passarem juntos no Render. O fluxo de refazer sorteio continua bloqueado assim
que houver o primeiro placar, inclusive o da ida.
