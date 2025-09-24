🤖 Sistema SDR/Agente de IA para WhatsApp
Sistema completo de qualificação de leads e agendamento automatizado via WhatsApp, integrado com N8N e alimentado por IA.
🚀 Funcionalidades
Automação Inteligente

✅ Processamento de mensagens com IA (OpenAI/GPT-4)
✅ Coleta automática de dados: Nome → Email → Empresa → Cargo
✅ Qualificação inteligente de necessidades
✅ Sistema de agendamento com horários disponíveis
✅ Integração completa com N8N

Gestão Avançada

✅ Dashboard em tempo real com métricas
✅ Analytics detalhado por período
✅ Sistema de lead scoring automático
✅ Lembretes automáticos de reuniões
✅ Logs detalhados e monitoramento

Tecnologias

✅ Backend Node.js + Express
✅ MongoDB para persistência
✅ WhatsApp Business API
✅ OpenAI GPT-4 para IA conversacional
✅ Deploy otimizado para Render
✅ Rate limiting e segurança robusta

📋 Pré-requisitos
Contas e Serviços Necessários

WhatsApp Business API - Meta Business
OpenAI API - OpenAI Platform
MongoDB - MongoDB Atlas ou Render Database
Render - Render.com para deploy
N8N (opcional) - Para integração avançada

Informações que Você Precisará

Token de verificação do WhatsApp
Access Token da WhatsApp Business API
Phone Number ID do WhatsApp
API Key da OpenAI
Connection String do MongoDB
URL do webhook N8N (se usando)

⚙️ Configuração Passo a Passo
1. Configuração do WhatsApp Business API

Acesse o Meta Business
Crie uma conta Business se não tiver
Vá em Ferramentas → WhatsApp Manager
Configure um número de telefone
Anote os seguintes dados:

WHATSAPP_ACCESS_TOKEN
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_BUSINESS_ACCOUNT_ID
WHATSAPP_VERIFY_TOKEN (você define este)



2. Configuração da OpenAI

Acesse OpenAI Platform
Crie uma conta e adicione créditos
Vá em API Keys e crie uma nova key
Anote a OPENAI_API_KEY

3. Configuração do MongoDB
Opção A: MongoDB Atlas (Recomendado)

Crie conta no MongoDB Atlas
Crie um cluster gratuito
Configure usuário e senha
Configure IP whitelist (0.0.0.0/0 para desenvolvimento)
Obtenha a connection string

Opção B: Render Database

No painel do Render, crie um PostgreSQL (ou use MongoDB via Atlas)
Anote os dados de conexão

4. Deploy no Render
Método 1: Via GitHub (Recomendado)

Faça fork/clone deste repositório

bashgit clone https://github.com/seu-usuario/whatsapp-sdr-agent.git
cd whatsapp-sdr-agent

Configure as variáveis de ambiente localmente

bashcp .env.example .env
# Edite o .env com seus dados

Teste localmente

bashnpm install
npm run dev

Push para seu GitHub

bashgit add .
git commit -m "Initial setup"
git push origin main

Deploy no Render

Acesse Render Dashboard
Clique em New → Web Service
Conecte seu repositório GitHub
Configure:

Name: whatsapp-sdr-agent
Environment: Node
Build Command: npm install
Start Command: npm start
Plan: Starter (gratuito para começar)




Configure as variáveis de ambiente no Render

Na aba Environment do seu serviço
Adicione todas as variáveis do .env.example



Método 2: Deploy Direto

Crie um novo Web Service no Render
Upload dos arquivos:

package.json
index.js
.env (com suas configurações)



5. Configuração do Webhook WhatsApp

Obtenha a URL do seu serviço Render

Exemplo: https://seu-app.onrender.com


Configure no WhatsApp Business API

URL do Webhook: https://seu-app.onrender.com/webhook
Token de Verificação: Use o mesmo valor de WHATSAPP_VERIFY_TOKEN
Campos subscritos: messages


Teste o webhook

Envie uma mensagem para seu número WhatsApp Business
Verifique os logs no Render



6. Configuração do N8N (Opcional)
Se você já tem N8N configurado:

Crie um webhook no N8N
Configure a URL no .env:

bash   N8N_WEBHOOK_URL=https://seu-n8n.com/webhook/lead-qualification
   N8N_WEBHOOK_TOKEN=seu_token_secreto

Estrutura de dados enviados:

json{
  "timestamp": "2024-01-01T12:00:00.000Z",
  "source": "whatsapp-sdr",
  "leadData": {
    "phoneNumber": "+5511999999999",
    "name": "João Silva",
    "email": "joao@empresa.com",
    "company": "Empresa XYZ",
    "position": "Gerente",
    "needs": "Automação de vendas",
    "leadScore": 85,
    "conversationStage": "COMPLETED",
    "appointmentScheduled": true
  },
  "appointment": {
    "date": "2024-01-15T10:00:00.000Z",
    "time": "10:00",
    "meetingId": "uuid-123"
  }
}
🔧 Configurações Avançadas
Personalização de Horários
Edite no .env:
bash# Horários de funcionamento
BUSINESS_HOURS_START=09:00
BUSINESS_HOURS_END=18:00
BUSINESS_DAYS=1,2,3,4,5  # 1=Segunda, 7=Domingo
MEETING_DURATION_MINUTES=30
BUFFER_MINUTES=15

# Timezone
TIMEZONE=America/Sao_Paulo
Configuração de Rate Limiting
bashRATE_LIMIT_WINDOW_MS=900000  # 15 minutos
RATE_LIMIT_MAX_REQUESTS=100  # 100 requests por janela
Configuração de Logs
bashLOG_LEVEL=info  # debug, info, warn, error
VERBOSE_LOGGING=false
📊 Endpoints da API
Endpoints Principais
MétodoEndpointDescriçãoGET/healthHealth check do sistemaGET/POST/webhookWebhook do WhatsAppGET/conversationsLista conversasGET/conversations/:phoneDetalhes de conversaGET/appointmentsLista agendamentosGET/availabilityHorários disponíveisGET/analyticsMétricas e analyticsGET/dashboardDashboard resumidoPOST/send-messageEnvio manual de mensagemPOST/sync-n8nSync forçado com N8N
Exemplos de Uso
Listar conversas ativas:
bashcurl https://seu-app.onrender.com/conversations?active=true&page=1&limit=20
Ver métricas do dashboard:
bashcurl https://seu-app.onrender.com/dashboard
Verificar horários disponíveis:
bashcurl https://seu-app.onrender.com/availability
🤖 Fluxo do Agente SDR
Estágios da Conversa

INITIAL - Primeira interação, coleta nome
COLLECTING_NAME - Processa nome fornecido
COLLECTING_EMAIL - Solicita e valida email
COLLECTING_COMPANY - Coleta empresa
COLLECTING_POSITION - Coleta cargo/posição
QUALIFYING_NEEDS - Entende necessidades
SHOWING_SCHEDULE - Apresenta horários
CONFIRMING_MEETING - Confirma agendamento
COMPLETED - Processo finalizado
ABANDONED - Conversa abandonada

Exemplo de Conversa
👤 Cliente: Olá
🤖 Bot: Olá! Sou o assistente da [Sua Empresa]. Como posso te chamar?

👤 Cliente: João
🤖 Bot: Prazer, João! Para te ajudar melhor, qual seu email?

👤 Cliente: joao@empresa.com
🤖 Bot: Perfeito! Em qual empresa você trabalha?

👤 Cliente: Empresa XYZ
🤖 Bot: Que legal! Qual sua posição na Empresa XYZ?

👤 Cliente: Sou gerente de vendas
🤖 Bot: Excelente! Como gerente de vendas, quais são seus maiores desafios hoje?

👤 Cliente: Preciso automatizar nosso processo de vendas
🤖 Bot: Entendo perfeitamente! Temos soluções que podem ajudar. Que tal agendarmos uma conversa?

📅 Horários Disponíveis:
*Segunda-feira, 15/01/2024*
- 09:00
- 10:00
- 14:00

Qual horário é melhor para você?

👤 Cliente: 10:00 segunda
🤖 Bot: ✅ Perfeito! Reunião agendada para Segunda, 15/01 às 10:00.
Você receberá lembretes. Nos vemos em breve! 🚀
📈 Monitoramento e Analytics
Métricas Disponíveis

Conversas ativas - Número atual de conversas em andamento
Mensagens por dia - Volume de mensagens processadas
Taxa de conversão - % de leads qualificados vs iniciados
Agendamentos - Reuniões marcadas
Lead Score médio - Pontuação média dos leads
Tempo de resposta - Tempo médio de processamento

Dashboard em Tempo Real
Acesse: https://seu-app.onrender.com/dashboard
Exemplo de resposta:
json{
  "metrics": {
    "activeConversations": 12,
    "todayAppointments": 3,
    "pendingResponses": 2,
    "todayMessages": 45,
    "todayQualifications": 8,
    "conversionRate": 17.8,
    "trends": {
      "messages": 15,
      "qualifications": -5
    }
  },
  "recentActivity": [
    {
      "phoneNumber": "+5511999999999",
      "name": "João Silva",
      "stage": "SHOWING_SCHEDULE",
      "timeAgo": "2 minutos"
    }
  ]
}
🔒 Segurança e Compliance
Medidas de Segurança Implementadas

✅ Rate Limiting - Proteção contra spam/ataques
✅ Helmet.js - Headers de segurança
✅ Validação de dados - Express-validator
✅ Logs estruturados - Winston logger
✅ Tratamento de erros - Error handling robusto
✅ Webhook verification - Validação de origem
✅ Environment variables - Dados sensíveis protegidos

LGPD / GDPR Compliance

Dados criptografados em trânsito
Logs sem informações pessoais sensíveis
Possibilidade de exclusão de dados
Consentimento implícito via interação

🚨 Troubleshooting
Problemas Comuns
1. Webhook não recebe mensagens
bash# Verificar configuração no Meta Business
# Testar com: curl https://seu-app.onrender.com/health
# Verificar logs no Render Dashboard
2. IA não responde adequadamente
bash# Verificar OPENAI_API_KEY
# Verificar créditos da conta OpenAI
# Ajustar OPENAI_TEMPERATURE (0.1-1.0)
3. MongoDB não conecta
bash# Verificar MONGODB_URI
# Verificar IP whitelist no Atlas
# Testar conexão local primeiro
4. N8N não recebe dados
bash# Verificar N8N_WEBHOOK_URL
# Testar com: POST /sync-n8n
# Verificar logs de erro
Logs e Debug
Ver logs em tempo real:
bash# No Render Dashboard → Seu serviço → Logs

# Localmente:
DEBUG=whatsapp-sdr:* npm run dev
Estrutura de logs:
json{
  "timestamp": "2024-01-01T12:00:00.000Z",
  "level": "info",
  "message": "Nova mensagem de +5511999999999: Olá...",
  "service": "whatsapp-sdr",
  "phoneNumber": "+5511999999999",
  "stage": "INITIAL"
}
🔄 Manutenção e Updates
Tarefas Automáticas

Geração de horários: Diariamente às 00:00
Limpeza de conversas: A cada 6 horas (abandona conversas > 24h)
Lembretes: A cada 15 minutos (24h e 2h antes)
Analytics: Atualização em tempo real

Backup e Restore
MongoDB Atlas (recomendado):

Backup automático configurado
Point-in-time recovery disponível

Backup manual:
bash# Export de dados
mongodump --uri="your_connection_string" --db=whatsapp_sdr

# Import de dados
mongorestore --uri="your_connection_string" --db=whatsapp_sdr dump/whatsapp_sdr/
🚀 Próximos Passos
Expansão Instagram
O sistema está preparado para expansão. Para adicionar Instagram:

Adicionar variáveis no .env:

bashINSTAGRAM_ACCESS_TOKEN=your_instagram_token
INSTAGRAM_BUSINESS_ACCOUNT_ID=your_account_id

Implementar endpoints similares aos do WhatsApp
Adaptar processamento de mensagens
Atualizar analytics para múltiplas fontes

Integrações Futuras

📅 Google Calendar - Sincronização automática
📧 Email Marketing - Nurturing de leads
📊 CRM - HubSpot, Pipedrive, etc.
🤖 Chatbots avançados - Dialogflow, Rasa
📱 Telegram - Canal adicional
💬 Slack - Notificações da equipe

📞 Suporte
Documentação Oficial

WhatsApp Business API
OpenAI API
MongoDB
Render

Comunidade e Ajuda

GitHub Issues: Reporte bugs e sugestões
Discord/Telegram: Comunidade de desenvolvedores
Email: suporte@suaempresa.com


📄 Licença
MIT License - veja arquivo LICENSE para detalhes.
🎯 Conclusão
Este sistema fornece uma base sólida e escalável para automação de vendas via WhatsApp. Com IA avançada, analytics detalhado e integrações robustas, você terá uma ferramenta poderosa para qualificação de leads e agendamento automatizado.
Ready for Production! 🚀

Desenvolvido com ❤️ para automatizar e escalar seu processo de vendas
