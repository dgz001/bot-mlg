# Monitor de torneios

Aplicado no Supabase Notebook em 2026-09-22. Job mlg-bot-tournament-health a cada 5 minutos, GET /readyz apenas com Copa aberta/em andamento em grupo autorizado. Sem credenciais HTTP. Timeout 10s, sem retries imediatos. Respostas privadas em mlg_bot.availability_checks, retenção 7 dias. Coleta assíncrona na execução seguinte; sucesso SQL não implica sucesso HTTP. Primeira requisição real retornou 200 sem timeout. Nenhum alerta enviado ao grupo.

Pode acordar Render adormecido por inatividade. Não substitui worker, não oferece failover ou SLA e não impede suspensão por cota. Não altera planos pagos. Não iniciar uma segunda sessão WhatsApp simultânea. Banco e Render continuam sendo dependências.

Desativação: SELECT cron.unschedule('mlg-bot-tournament-health');

Migração já aplicada; branch separada evita redeploy durante Copa ativa. Consultar schema_migrations antes de reaplicar.
