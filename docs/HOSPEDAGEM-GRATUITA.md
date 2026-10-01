# Bot e painel sem mensalidade

Em 30/09/2026, o Render informa suspensão por `billing` e responde 503. O último deploy foi bem-sucedido. A integração não revela qual franquia ou pendência específica causou o bloqueio, e não permite removê-lo. Conferir https://dashboard.render.com/billing#included-usage.

O Render Free compartilha 750 horas mensais por workspace. Criar outro serviço no mesmo workspace não amplia a franquia. Excesso de banda sem meio de pagamento também pode suspender serviços. A renovação mensal pode resolver franquia esgotada, mas não outras pendências. Não foi contornada a suspensão.

A correção do cofre evita reenviar estado idêntico, incluindo chamadas concorrentes. Alterações reais continuam sendo gravadas; todas as chamadas que compartilham uma gravação recebem a mesma falha se ela falhar. O formato cifrado permanece compatível. Reduz desperdício, sem aumentar cotas nem prometer resolver faturamento.

## Alternativa gratuita na nuvem

Uma VM **Oracle Cloud Always Free** pode hospedar o processo WhatsApp e o painel, mantendo Supabase como banco/cofre. Isso substitui o processo hospedado no Render. Vercel e Supabase não mantêm o socket deste bot continuamente só por hospedarem páginas ou funções.

Cadastro pessoal: https://www.oracle.com/cloud/free/. Normalmente exige cartão para verificação e pode envolver autorização temporária. O dono precisa cadastrar/verificar a conta; não enviar dados de cartão ou senhas no chat. Usar somente recursos marcados **Always Free eligible**, na região de origem e dentro das cotas do console. Conferir compute e volume; não contratar recursos pagos nem habilitar Pay As You Go automaticamente. Disponibilidade varia; VMs ociosas podem ser recolhidas.

Requisitos oficiais: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm.

## Configuração preparada

`deploy/compose.free-cloud.yaml` inicia um único bot e o proxy Caddy com HTTPS, reinício automático e logs limitados. A porta do bot não é exposta publicamente. O financeiro fica desligado. Sessão e filas permanecem no cofre Supabase.

Na VM Ubuntu com Docker Engine e plugin Compose instalados, clonar o repositório com esta configuração e executar na raiz:

```
cp deploy/free-cloud.env.example .env.runtime
chmod 600 .env.runtime
```

Editar os segredos diretamente na VM. Preservar `AUTH_ENCRYPTION_KEY`, `SESSION_VAULT_URL`, `SESSION_VAULT_TOKEN`, `MINICAMP_URL` e `MINICAMP_TOKEN` da instalação existente. Uma chave diferente não abre a sessão. Esses valores devem ser obtidos pelo dono no dashboard/gerenciador de segredos; a integração da revisão não os exporta. Definir uma senha forte em `CONTROL_PASSWORD`.

`PANEL_HOST` deve resolver para o IP público da VM. `CONTROL_ORIGIN` deve ser `https://MESMO_HOSTNAME`, sem caminho nem barra final. Sem domínio próprio, `IP-PUBLICO.sslip.io` oferece uma possibilidade de DNS gratuito (exemplo fictício: `203.0.113.10.sslip.io`). Depende de DNS externo e emissão de certificado; limites de emissão podem exigir outro hostname/DNS. Não exige compra de domínio, mas não garante disponibilidade.

Permitir TCP 80/443 na rede Oracle e firewall da VM; restringir SSH 22 aos IPs administrativos. Não expor 3000. Conferir saída para WhatsApp e Supabase. O Caddy emite certificado automaticamente quando DNS e portas estão corretos.

**Antes de iniciar a VM, deixar a instalação do Render explicitamente suspensa pelo administrador.** A suspensão por franquia pode ser removida automaticamente na renovação mensal. Nunca deixar duas instalações conectarem a mesma sessão WhatsApp. Se não for possível suspender explicitamente a origem, aguardar resolver esse controle antes da migração. Não excluir o cofre nem trocar sua chave.

```
docker compose --env-file .env.runtime -f deploy/compose.free-cloud.yaml config --quiet
docker compose --env-file .env.runtime -f deploy/compose.free-cloud.yaml up -d --build
docker compose --env-file .env.runtime -f deploy/compose.free-cloud.yaml ps
```

Abrir `https://PANEL_HOST`, autenticar e conferir `/livez`, conexão WhatsApp e um comando controlado. A URL antiga `.onrender.com` não acompanha a migração. Se a VM não tiver memória para construir a imagem, escolher mais memória dentro de uma forma/cota Always Free disponível ou construir a imagem em outro ambiente. Não contratar máquina paga automaticamente.

Nenhuma conta, VM, domínio ou recurso pago foi criado. Nenhum bot foi iniciado em uma segunda hospedagem. DNS, certificado, elegibilidade e conexão real precisam ser verificados na VM; a preparação local não equivale a uma migração concluída.
