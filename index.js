/**
 * SISTEMA SDR WHATSAPP - VERSÃO PRODUÇÃO CORRIGIDA
 * N8N + genAI + MongoDB + Google Calendar
 */

const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const moment = require('moment-timezone');
const { v4: uuidv4 } = require('uuid');
const { GoogleGenerativeAI } = require('@google/generative-ai')
const winston = require('winston');
const compression = require('compression');
// const { google } = require('googleapis');

require('dotenv').config();

// ============================================================================
// CONFIGURAÇÃO
// ============================================================================

const app = express();
const PORT = process.env.PORT || 3000;

// genAI
let genAI;
if (process.env.AI_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.AI_API_KEY);
}

// Google Calendar
// const oauth2Client = new google.auth.OAuth2(
//   process.env.GOOGLE_CLIENT_ID,
//   process.env.GOOGLE_CLIENT_SECRET,
//   process.env.GOOGLE_REDIRECT_URI
// );

// if (process.env.GOOGLE_REFRESH_TOKEN) {
//   oauth2Client.setCredentials({
//     refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
//   });
// }

// const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

// ============================================================================
// MIDDLEWARES
// ============================================================================

app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests' }
});
app.use('/webhook', limiter);

// ============================================================================
// MONGODB SCHEMAS
// ============================================================================

const ConversationSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true, index: true },
  contactName: { type: String, default: '' },
  stage: { 
    type: String, 
    enum: ['INITIAL', 'SOLICITAR_NOME', 'SOLICITAR_FUNCAO', 'SOLICITAR_EMAIL', 'OFERECER_AGENDAMENTOS', 'AGENDAMENTO_CONFIRMADO', 'COMPLETED', 'ABANDONED'],
    default: 'INITIAL'
  },
  userData: {
    name: String,
    function: String,
    email: String,
    leadScore: { type: Number, default: 0 }
  },
  appointment: {
    scheduled: { type: Boolean, default: false },
    eventId: String,
    meetLink: String,
    scheduledDate: Date,
    status: { 
      type: String, 
      enum: ['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED'],
      default: 'PENDING'
    }
  },
  messages: [{
    timestamp: { type: Date, default: Date.now },
    direction: { type: String, enum: ['INCOMING', 'OUTGOING'] },
    content: String,
    messageId: String
  }],
  n8nData: {
    sent: { type: Boolean, default: false },
    lastSent: Date
  },
  metadata: {
    lastActivity: { type: Date, default: Date.now },
    conversationStarted: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true }
  }
}, {
  timestamps: true
});

const Conversation = mongoose.model('Conversation', ConversationSchema);

// ============================================================================
// MONGODB CONNECTION
// ============================================================================

const connectMongoDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    logger.info('MongoDB connected successfully');
  } catch (error) {
    logger.error('MongoDB connection error:', error);
    if (process.env.NODE_ENV !== 'production') {
      process.exit(1);
    }
  }
};

// ============================================================================
// GOOGLE CALENDAR FUNCTIONS
// ============================================================================

async function getAvailableSlots(daysAhead = 7) {
  try {
    const timezone = process.env.TIMEZONE || 'America/Sao_Paulo';
    const availableSlots = [];
    
    for (let day = 1; day <= daysAhead; day++) {
      const currentDay = moment().tz(timezone).add(day, 'days');
      
      // Pula fins de semana
      if (currentDay.day() === 0 || currentDay.day() === 6) continue;
      
      // Cria slots de 30min das 9h às 17h
      for (let hour = 9; hour < 17; hour++) {
        for (let minute = 0; minute < 60; minute += 30) {
          const slotStart = currentDay.clone().hour(hour).minute(minute).second(0);
          
          if (slotStart.isAfter(moment())) {
            availableSlots.push({
              datetime: slotStart.toISOString(),
              display: slotStart.format('dddd DD/MM [às] HH:mm[h]'),
              shortDisplay: slotStart.format('ddd DD/MM HH:mm')
            });
          }
        }
      }
    }
    
    return availableSlots.slice(0, 6);
    
  } catch (error) {
    logger.error('Error getting available slots:', error);
    return [];
  }
}

async function scheduleGoogleCalendarEvent(conversation, selectedSlot) {
  try {
    // TEMPORÁRIO: Simulação até configurar Google Calendar
    const startTime = moment(selectedSlot).tz('America/Sao_Paulo');
    
    logger.info(`Agendamento simulado para ${conversation.userData.name} em ${startTime.format('DD/MM/YYYY HH:mm')}`);
    
    return {
      success: true,
      eventId: 'temp_' + uuidv4(),
      meetLink: 'https://meet.google.com/temp-meeting-' + Math.random().toString(36).substring(7),
      startTime: startTime.toISOString()
    };

  } catch (error) {
    logger.error('Agendamento temporário error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}


// ============================================================================
// AI PROCESSING
// ============================================================================

async function processMessageWithAI(message, conversation) {
  try {
    const currentStage = conversation.stage || 'INITIAL';
    const userData = conversation.userData || {};
    
    const systemPrompts = {
      'INITIAL': `Você é um assistente SDR profissional. Cumprimente e colete o NOME completo da pessoa.`,
      'SOLICITAR_NOME': `Colete o nome completo. Se já forneceu, prossiga pedindo a FUNÇÃO na empresa.`,
      'SOLICITAR_FUNCAO': `Nome: ${userData.name}. Agora colete a FUNÇÃO/CARGO da pessoa na empresa.`,
      'SOLICITAR_EMAIL': `Nome: ${userData.name}, Função: ${userData.function}. Colete o EMAIL profissional.`,
      'OFERECER_AGENDAMENTOS': `Dados coletados. Ofereça opções de agendamento para uma conversa detalhada.`,
      'AGENDAMENTO_CONFIRMADO': `Confirme os detalhes da reunião agendada.`
    };

    const prompt = `${systemPrompts[currentStage]}

RESPONDA APENAS COM JSON VÁLIDO:
{
  "intent": "greeting|providing_info|confirming|scheduling|selecting_slot|other",
  "extracted_data": {
    "name": "string ou null",
    "function": "string ou null", 
    "email": "string ou null",
    "selected_slot": "string ou null"
  },
  "response": "resposta para o usuário",
  "next_stage": "${getNextStage(currentStage)}|${currentStage}",
  "confidence": 0.8,
  "needs_calendar_slots": false,
  "schedule_meeting": false
}

MENSAGEM: "${message}"`;

   if (!genAI) {
  throw new Error('Google AI não configurado');
}
const model = genAI.getGenerativeModel({ model: "gemini-pro" });
const result = await model.generateContent(prompt);
const response = await result.response;
const text = response.text();
    return JSON.parse(response.choices[0].message.content);

  } catch (error) {
    logger.error('AI processing error:', error);
    return {
      intent: 'error',
      extracted_data: {},
      response: 'Desculpe, tive um problema técnico. Pode repetir?',
      next_stage: conversation.stage,
      confidence: 0,
      needs_calendar_slots: false,
      schedule_meeting: false
    };
  }
}

function getNextStage(currentStage) {
  const stageFlow = {
    'INITIAL': 'SOLICITAR_NOME',
    'SOLICITAR_NOME': 'SOLICITAR_FUNCAO', 
    'SOLICITAR_FUNCAO': 'SOLICITAR_EMAIL',
    'SOLICITAR_EMAIL': 'OFERECER_AGENDAMENTOS',
    'OFERECER_AGENDAMENTOS': 'AGENDAMENTO_CONFIRMADO',
    'AGENDAMENTO_CONFIRMADO': 'COMPLETED'
  };
  
  return stageFlow[currentStage] || 'COMPLETED';
}

// ============================================================================
// WHATSAPP API
// ============================================================================

async function sendWhatsAppMessage(phoneNumber, message) {
  try {
    const url = `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    
    const payload = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'text',
      text: { body: message }
    };

    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    logger.info(`WhatsApp message sent to ${phoneNumber}`);
    return response.data;

  } catch (error) {
    logger.error('WhatsApp API error:', error);
    throw error;
  }
}

// ============================================================================
// N8N INTEGRATION
// ============================================================================

async function sendToN8N(conversation) {
  try {
    const n8nPayload = {
      phoneNumber: conversation.phoneNumber,
      contactName: conversation.contactName || conversation.userData?.name || 'Sem nome',
      currentStage: conversation.stage,
      normalizedData: {
        nome: conversation.userData?.name || '',
        funcao: conversation.userData?.function || '',
        email: conversation.userData?.email || '',
        telefone: conversation.phoneNumber,
        lead_score: conversation.userData?.leadScore || 0
      },
      appointmentData: {
        scheduled: conversation.appointment?.scheduled || false,
        eventId: conversation.appointment?.eventId || null,
        meetLink: conversation.appointment?.meetLink || null,
        status: conversation.appointment?.status || 'PENDING'
      },
      systemData: {
        timestamp: new Date().toISOString(),
        source: 'sdr-backend',
        version: '2.1.0',
        hasCalendarIntegration: true
      }
    };

    const n8nUrl = process.env.N8N_WEBHOOK_URL || 'https://saffron-app.n8n.cloud/webhook/lead-qualification';
    
    const response = await axios.post(n8nUrl, n8nPayload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });

    logger.info(`N8N integration successful for ${conversation.phoneNumber}`);
    return { success: true, response: response.data };

  } catch (error) {
    logger.error('N8N integration error:', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// CORE MESSAGE PROCESSING
// ============================================================================

async function processIncomingMessage(phoneNumber, messageText, messageId, contactName = '') {
  try {
    let conversation = await Conversation.findOne({ 
      phoneNumber: phoneNumber,
      'metadata.isActive': true 
    });

    if (!conversation) {
      conversation = new Conversation({
        phoneNumber: phoneNumber,
        contactName: contactName,
        stage: 'INITIAL',
        userData: {},
        appointment: { scheduled: false, status: 'PENDING' },
        messages: [],
        metadata: {
          conversationStarted: new Date(),
          lastActivity: new Date(),
          isActive: true
        }
      });
    }

    // Adiciona mensagem recebida
    conversation.messages.push({
      timestamp: new Date(),
      direction: 'INCOMING',
      content: messageText,
      messageId: messageId
    });

    // Processa com IA
    const aiResult = await processMessageWithAI(messageText, conversation);

    // Atualiza dados extraídos
    if (aiResult.extracted_data) {
      Object.keys(aiResult.extracted_data).forEach(key => {
        if (aiResult.extracted_data[key] && aiResult.extracted_data[key] !== 'null') {
          if (!conversation.userData) conversation.userData = {};
          conversation.userData[key] = aiResult.extracted_data[key];
        }
      });
    }

    // Atualiza estágio
    if (aiResult.next_stage && aiResult.next_stage !== conversation.stage) {
      conversation.stage = aiResult.next_stage;
    }

    // Calcula lead score
    conversation.userData.leadScore = calculateLeadScore(conversation);

    let finalResponse = aiResult.response;

    // Lógica de agendamento
    if (aiResult.needs_calendar_slots && conversation.stage === 'OFERECER_AGENDAMENTOS') {
      const availableSlots = await getAvailableSlots();
      
      if (availableSlots.length > 0) {
        finalResponse += '\n\nHorários disponíveis:\n' + 
          availableSlots.map((slot, index) => `${index + 1}. ${slot.display}`).join('\n') +
          '\n\nDigite o número da opção (ex: 1, 2, 3...)';
      }
    }

    // Agendar reunião
    if (aiResult.schedule_meeting || (conversation.stage === 'OFERECER_AGENDAMENTOS' && aiResult.extracted_data.selected_slot)) {
      const slotIndex = parseInt(messageText.trim()) - 1;
      const availableSlots = await getAvailableSlots();
      
      if (slotIndex >= 0 && slotIndex < availableSlots.length) {
        const selectedSlot = availableSlots[slotIndex];
        const schedulingResult = await scheduleGoogleCalendarEvent(conversation, selectedSlot.datetime);
        
        if (schedulingResult.success) {
          conversation.appointment = {
            scheduled: true,
            eventId: schedulingResult.eventId,
            meetLink: schedulingResult.meetLink,
            scheduledDate: new Date(selectedSlot.datetime),
            status: 'CONFIRMED'
          };
          
          conversation.stage = 'AGENDAMENTO_CONFIRMADO';
          
          finalResponse = `✅ Reunião agendada para ${selectedSlot.display}!\n\n` +
            `📧 Você receberá um convite por email com o link do Google Meet.\n\n` +
            `📅 Link: ${schedulingResult.meetLink}\n\nAté lá! 😊`;
        }
      }
    }

    // Adiciona resposta
    conversation.messages.push({
      timestamp: new Date(),
      direction: 'OUTGOING',
      content: finalResponse,
      messageId: uuidv4()
    });

    conversation.metadata.lastActivity = new Date();
    await conversation.save();

    // Envia resposta via WhatsApp
    await sendWhatsAppMessage(phoneNumber, finalResponse);

    // Integração N8N
    try {
      const n8nResult = await sendToN8N(conversation);
      conversation.n8nData = {
        sent: n8nResult.success,
        lastSent: new Date()
      };
      await conversation.save();
    } catch (n8nError) {
      logger.error('N8N integration failed:', n8nError.message);
    }

    return {
      success: true,
      stage: conversation.stage,
      appointmentScheduled: conversation.appointment?.scheduled || false
    };

  } catch (error) {
    logger.error('Message processing error:', error);
    
    try {
      await sendWhatsAppMessage(phoneNumber, 'Desculpe, tive um problema técnico. Pode tentar novamente?');
    } catch (sendError) {
      logger.error('Failed to send error message:', sendError);
    }

    return { success: false, error: error.message };
  }
}

function calculateLeadScore(conversation) {
  let score = 0;
  const userData = conversation.userData || {};
  
  if (userData.name) score += 20;
  if (userData.function) score += 20;  
  if (userData.email) score += 20;
  
  const messageCount = conversation.messages?.filter(m => m.direction === 'INCOMING').length || 0;
  score += Math.min(messageCount * 3, 25);
  
  const stageScores = {
    'INITIAL': 1, 'SOLICITAR_NOME': 3, 'SOLICITAR_FUNCAO': 6,
    'SOLICITAR_EMAIL': 10, 'OFERECER_AGENDAMENTOS': 12,
    'AGENDAMENTO_CONFIRMADO': 15, 'COMPLETED': 15
  };
  score += stageScores[conversation.stage] || 0;
  
  if (conversation.appointment?.scheduled) score += 15;
  
  return Math.min(score, 100);
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

app.get('/health', async (req, res) => {
  try {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '2.1.0',
      services: {}
    };

    // Testa MongoDB
    try {
      await mongoose.connection.db.admin().ping();
      health.services.mongodb = 'connected';
    } catch (e) {
      health.services.mongodb = 'disconnected';
    }

    health.services.googleAI = process.env.AI_API_KEY ? 'configured' : 'not_configured';
    health.services.whatsapp = process.env.WHATSAPP_ACCESS_TOKEN ? 'configured' : 'not_configured';
    health.services.google_calendar = process.env.GOOGLE_CLIENT_ID ? 'configured' : 'not_configured';

    res.json(health);
  } catch (error) {
    res.status(503).json({ status: 'unhealthy', error: error.message });
  }
});

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('Webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

// Webhook message receiver
app.post('/webhook', [body('entry').isArray().notEmpty()], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { entry } = req.body;
    res.status(200).json({ status: 'received' });

    // Processa mensagens em background
    for (const entryItem of entry) {
      if (!entryItem.changes) continue;

      for (const change of entryItem.changes) {
        if (change.field !== 'messages') continue;

        const { messages, contacts } = change.value;
        if (!messages) continue;

        for (const message of messages) {
          if (message.type !== 'text') continue;

          const phoneNumber = message.from;
          const messageText = message.text.body;
          const messageId = message.id;
          const contact = contacts?.find(c => c.wa_id === phoneNumber);
          const contactName = contact?.profile?.name || '';

          logger.info(`New message from ${phoneNumber}: ${messageText.substring(0, 50)}...`);

          // Processa mensagem
          setImmediate(async () => {
            try {
              await processIncomingMessage(phoneNumber, messageText, messageId, contactName);
            } catch (error) {
              logger.error('Background processing error:', error);
            }
          });
        }
      }
    }

  } catch (error) {
    logger.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Google Calendar Auth
app.get('/auth/google', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar']
  });
  res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  
  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.json({
      success: true,
      message: 'Configure these tokens:',
      tokens: {
        GOOGLE_REFRESH_TOKEN: tokens.refresh_token,
        GOOGLE_ACCESS_TOKEN: tokens.access_token
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'OAuth failed' });
  }
});

// Available slots
app.get('/calendar/available-slots', async (req, res) => {
  try {
    const slots = await getAvailableSlots();
    res.json({ success: true, slots });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get slots' });
  }
});

// Test N8N
app.post('/test-n8n', async (req, res) => {
  try {
    const testData = {
      phoneNumber: '+5511999999999',
      contactName: 'Teste N8N',
      currentStage: 'COMPLETED',
      normalizedData: {
        nome: 'João Teste',
        funcao: 'Desenvolvedor',
        email: 'teste@exemplo.com',
        telefone: '+5511999999999'
      }
    };

    const n8nUrl = process.env.N8N_WEBHOOK_URL;
    const response = await axios.post(n8nUrl, testData, {
      headers: { 'Content-Type': 'application/json' }
    });

    res.json({ success: true, n8nResponse: response.data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Monitor dashboard
app.get('/monitor', (req, res) => {
  const html = `<!DOCTYPE html>
<html>
<head>
    <title>SDR WhatsApp Monitor</title>
    <style>
        body { font-family: Arial; background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 20px; }
        .card { background: rgba(255,255,255,0.9); color: #333; padding: 20px; border-radius: 10px; margin: 10px; }
        .metric { text-align: center; }
        .metric h2 { font-size: 2rem; margin: 0; }
    </style>
</head>
<body>
    <h1>📅 SDR WhatsApp + Agendamento Automático</h1>
    <div class="card">
        <div class="metric">
            <h2>Sistema Funcionando</h2>
            <p>N8N + OpenAI + MongoDB + Google Calendar</p>
            <p><a href="/health">Health Check</a> | <a href="/auth/google">Config Google</a></p>
        </div>
    </div>
</body>
</html>`;
  res.send(html);
});

// ============================================================================
// SERVER INITIALIZATION
// ============================================================================

async function startServer() {
  try {
    await connectMongoDB();
    
    const server = app.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 SDR WhatsApp Server running on port ${PORT}`);
      logger.info(`🔗 Webhook: ${process.env.BASE_URL || `http://localhost:${PORT}`}/webhook`);
      logger.info(`📅 Calendar Auth: ${process.env.BASE_URL || `http://localhost:${PORT}`}/auth/google`);
      logger.info(`📊 Monitor: ${process.env.BASE_URL || `http://localhost:${PORT}`}/monitor`);
      logger.info(`💚 Health: ${process.env.BASE_URL || `http://localhost:${PORT}`}/health`);
    });

    const shutdown = async (signal) => {
      logger.info(`${signal} received, shutting down...`);
      server.close(async () => {
        try {
          await mongoose.connection.close();
          process.exit(0);
        } catch (error) {
          process.exit(1);
        }
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.error('Server startup failed:', error);
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

startServer();
