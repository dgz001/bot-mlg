# Banco Supabase — MLG BOT

O banco escolhido é o projeto Supabase existente Notebook, em schema privado `mlg_bot`. O projeto da plataforma MLG permanece independente. As tabelas preexistentes no schema `public` foram preservadas.

## Estado verificado

- Bootstrap aplicado: 23 tabelas, versões internas 1 e 2.
- Acesso ao schema e à tabela de autenticação negado a `anon`, `authenticated` e `service_role`.
- Teste SQL transacional rejeitou empate e confirmação pelo próprio proponente sem resolução; fixtures revertidas por ROLLBACK.
- Testes locais: 14 passaram, 4 de integração ignorados por falta de banco de teste; TypeScript passou.
- O worker ainda não foi conectado a este banco. Não há sessão WhatsApp pareada.

`deploy/supabase-bootstrap.sql` registra o bootstrap aplicado via migration remota `mlg_bot_initial_private_schema`. Executar somente em schema ainda inexistente; não reaplicar sobre tabelas existentes. As migrations 001 e 002 continuam sendo a origem da estrutura; o bootstrap acrescenta revogação explícita das permissões das APIs Supabase. Não exponha `mlg_bot` na Data API.

## Próxima instalação

É necessário um host Docker/Node.js persistente para o Baileys. Supabase Edge Functions não hospedam este processo continuamente. A troca do banco não resolve o acesso do host ao GitHub.

Configure a conexão PostgreSQL e os segredos somente no painel privado do host. Nunca use chave da API Supabase como senha PostgreSQL. Use TLS com certificado verificado e conexão direta ou pooler em modo sessão, pois o worker usa advisory locks de sessão. Não use pooler em modo transação. A compatibilidade do provisionamento do usuário `mlg_bot_app` e da URL precisa ser validada no host antes de iniciar.

O worker deve acessar somente `mlg_bot` com usuário próprio. Nenhuma credencial foi gerada ou publicada nesta etapa. Não há backup externo do bot configurado; confirmar a disponibilidade de backups do plano antes de operar com dados reais.

Após validar o worker, realizar o pareamento pelo terminal privado descrito em OPERATIONS.md. Não enviar códigos, QR ou sessão ao chat. O procedimento de acesso ao terminal depende do host escolhido.
