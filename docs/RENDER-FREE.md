# Instalação gratuita no Render

O serviço mlg-bot-runtime é Node.js nativo, plano free. Substitui o blueprint anterior de worker pago. Não criar um segundo serviço para a mesma conta WhatsApp.

O Render pode suspender a instância após 15 minutos sem tráfego de entrada. Abrir a página do bot solicita seu despertar; comandos enviados no WhatsApp enquanto ele estiver offline não despertam o Render. Não há disponibilidade 24/7 garantida. Não usar pings artificiais para contornar a suspensão.

## Configuração privada

No painel Render, Environment, configurar DATABASE_URL com a conexão do projeto Supabase Notebook, modo Session pooler (porta 5432), usuário de migração e senha, TLS com certificado verificado. Obter o endereço real em Connect no Supabase, não adivinhar o hostname. Não usar Transaction pooler nem chave anon/service_role como senha. Se a senha contém caracteres especiais, codificá-los na URL. Nunca colar a conexão no chat, Git ou logs. Não redefinir a senha do banco sem avaliar os outros consumidores do Notebook.

APP_DATABASE_PASSWORD, AUTH_ENCRYPTION_KEY e CONTROL_PASSWORD foram geradas diretamente no serviço. Não regenerar a chave de autenticação após parear. CONTROL_ORIGIN deve coincidir exatamente com a origem HTTPS do serviço.

A instalação ainda precisa validar a conexão e os privilégios do usuário de migração no Supabase. Erros de migração são registrados apenas como MIGRATIONS_FAILED. A suite de integração requer banco descartável próprio; os testes locais sem ele ficam marcados como ignorados.

## Pareamento no celular

Após o deploy ficar operacional, abra a página HTTPS do serviço. Consulte CONTROL_PASSWORD apenas no painel privado do Render e informe-a na página do bot. A senha fica somente na memória da página, sem localStorage, cookies ou URL. Gere o código, autorize no WhatsApp oficial, depois verifique CONNECTED. Código desaparece da tela após um minuto ou ao colocar a página em segundo plano. Não faça captura/transmissão de tela durante esse passo.

Após adicionar o bot ao grupo: carregar grupos, selecionar o grupo, carregar participantes, conferir seu identificador, informar pelo menos 16 clubes únicos e autorizar. A senha do painel dá poderes administrativos sobre a conta; não compartilhar. Sair limpa os campos da página. Reiniciar o serviço limpa bloqueios temporários; chaves e Copas ficam no PostgreSQL.

Sem senha correta, requisições de controle são negadas. Escritas exigem origem HTTPS exata e cabeçalho personalizado; o endpoint não habilita CORS. Não há endpoint público que revele sessão ou código. A página HTML pública é apenas o formulário de acesso.
