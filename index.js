/**
 * SISTEMA SDR WHATSAPP - PRODUÇÃO COMPLETA
 * Integração N8N + OpenAI + MongoDB + GOOGLE CALENDAR AUTOMÁTICO
 * Deploy automático Render
 */

const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const moment = require('moment-timezone');
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');
const winston = require('winston');
const compression = require('compression');
const cron = require('node-cron');
const { google } = require('googleapis');

require('dotenv').config();

// ============================================================================
// CONFIGURAÇÃO E INICIALIZAÇÃO
// ============================================================================

const app = express();
const PORT = process.env.PORT || 3000;

// OpenAI Configuration
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 🆕 GOOGLE CALENDAR CONFIGURATION
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Set credentials if available
if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
}

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// Logger Configuration
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      return `${timestamp} [${level.toUpperCase()}] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ],
});

// Adiciona arquivo de log se não for Render
if (process.env.NODE_ENV !== 'production' || !process.env.RENDER) {
  logger.add(new winston.transports.File({ filename: 'app.log' }));
}

// ============================================================================
// MIDDLEWARES
// ============================================================================

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting mais permissivo para produção
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/webhook', limiter);

app.use(morgan(':method :url :status :res[content-length] - :response-time ms', {
  stream: { write: message => logger.info(message.trim()) }
}));

// ============================================================================
// MONGODB SCHEMAS - COM AGENDAMENTO
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
    interests: String,
    appointmentPreference: String,
    selectedSlot: String,
    leadScore: { type: Number, default: 0 }
  },
  // 🆕 AGENDAMENTO DATA
  appointment: {
    scheduled: { type: Boolean, default: false },
    eventId: String,
    meetLink: String,
    scheduledDate: Date,
    scheduledTime: String,
    duration: { type: Number, default: 30 },
    status: { 
      type: String, 
      enum: ['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED'],
      default: 'PENDING'
    },
    remindersSent: {
      day_before: { type: Boolean, default: false },
      hour_before: { type: Boolean, default: false }
    }
  },
  messages: [{
    timestamp: { type: Date, default: Date.now },
    direction: { type: String, enum: ['INCOMING', 'OUTGOING'] },
    content: String,
    messageId: String,
    aiAnalysis: {
      intent: String,
      entities: Object,
      confidence: Number,
      processing_time: Number
    }
  }],
  n8nData: {
    sent: { type: Boolean, default: false },
    lastSent: Date,
    webhookResponse: Object
  },
  metadata: {
    source: { type: String, default: 'whatsapp' },
    lastActivity: { type: Date, default: Date.now },
    conversationStarted: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true },
    retryCount: { type: Number, default: 0 }
  }
}, {
  timestamps: true,
  collection: 'conversations'
});

const AnalyticsSchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true },
  metrics: {
    totalMessages: { type: Number, default: 0 },
    newConversations: { type: Number, default: 0 },
    completedConversations: { type: Number, default: 0 },
    abandonnedConversations: { type: Number, default: 0 },
    scheduledMeetings: { type: Number, default: 0 }, // 🆕
    confirmedMeetings: { type: Number, default: 0 }, // 🆕
    averageResponseTime: { type: Number, default: 0 },
    conversionRate: { type: Number, default: 0 },
    schedulingRate: { type: Number, default: 0 }, // 🆕
    n8nIntegrations: { type: Number, default: 0 }
  },
  stageBreakdown: {
    initial: { type: Number, default: 0 },
    solicitar_nome: { type: Number, default: 0 },
    solicitar_funcao: { type: Number, default: 0 },
    solicitar_email: { type: Number, default: 0 },
    oferecer_agendamentos: { type: Number, default: 0 },
    agendamento_confirmado: { type: Number, default: 0 }, // 🆕
    completed: { type: Number, default: 0 }
  }
}, {
  timestamps: true,
  collection: 'analytics'
});

const Conversation = mongoose.model('Conversation', ConversationSchema);
const Analytics = mongoose.model('Analytics', AnalyticsSchema);

// ============================================================================
// MONGODB CONNECTION
// ============================================================================

const connectMongoDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      family: 4
    });
    logger.info('✅ MongoDB connected successfully');
  } catch (error) {
    logger.error('❌ MongoDB connection error:', error);
    if (process.env.NODE_ENV !== 'production') {
      process.exit(1);
    } else {
      setTimeout(connectMongoDB, 5000);
    }
  }
};

// ============================================================================
// 🆕 GOOGLE CALENDAR FUNCTIONS - AGENDAMENTO AUTOMÁTICO
// ============================================================================

async function getAvailableSlots(daysAhead = 7) {
  try {
    const timezone = process.env.TIMEZONE || 'America/Sao_Paulo';
    const businessStart = parseInt(process.env.BUSINESS_HOURS_START?.split(':')[0] || '9');
    const businessEnd = parseInt(process.env.BUSINESS_HOURS_END?.split(':')[0] || '18');
    const meetingDuration = parseInt(process.env.MEETING_DURATION_MINUTES || '30');
    const bufferMinutes = parseInt(process.env.BUFFER_MINUTES || '15');
    
    const availableSlots = [];
    
    for (let day = 1; day <= daysAhead; day++) {
      const currentDay = moment().tz(timezone).add(day, 'days');
      
      // Pula fins de semana (sábado = 6, domingo = 0)
      if (currentDay.day() === 0 || currentDay.day() === 6) continue;
      
      // Busca eventos existentes para este dia
      const dayStart = currentDay.clone().hour(businessStart).minute(0).second(0);
      const dayEnd = currentDay.clone().hour(businessEnd).minute(0).second(0);
      
      const existingEvents = await calendar.events.list({
        calendarId: process.env.CALENDAR_ID || 'primary',
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });

      // Gera slots disponíveis
      const busyTimes = existingEvents.data.items?.map(event => ({
        start: moment(event.start.dateTime || event.start.date),
        end: moment(event.end.dateTime || event.end.date)
      })) || [];

      // Cria slots de 30min das 9h às 18h
      for (let hour = businessStart; hour < businessEnd; hour++) {
        for (let minute = 0; minute < 60; minute += meetingDuration) {
          const slotStart = currentDay.clone().hour(hour).minute(minute).second(0);
          const slotEnd = slotStart.clone().add(meetingDuration, 'minutes');
          
          // Verifica se não conflita com eventos existentes
          const isAvailable = !busyTimes.some(busy => 
            slotStart.isBefore(busy.end) && slotEnd.isAfter(busy.start)
          );
          
          if (isAvailable && slotStart.isAfter(moment())) {
            availableSlots.push({
              datetime: slotStart.toISOString(),
              display: slotStart.format('dddd DD/MM [às] HH:mm[h]'),
              shortDisplay: slotStart.format('ddd DD/MM HH:mm'),
              dayOfWeek: slotStart.format('dddd')
            });
          }
        }
      }
    }
    
    return availableSlots.slice(0, 6); // Limita a 6 opções
    
  } catch (error) {
    logger.error('Error getting available slots:', error);
    return [];
  }
}

async function scheduleGoogleCalendarEvent(conversation, selectedSlot) {
  try {
    const timezone = process.env.TIMEZONE || 'America/Sao_Paulo';
    const meetingDuration = parseInt(process.env.MEETING_DURATION_MINUTES || '30');
    
    const startTime = moment(selectedSlot).tz(timezone);
    const endTime = startTime.clone().add(meetingDuration, 'minutes');
    
    const eventTitle = `${process.env.MEETING_TITLE_PREFIX || 'Reunião SDR -'} ${conversation.userData.name}`;
    
    const event = {
      summary: eventTitle,
      description: `
🤖 Reunião agendada automaticamente pelo Sistema SDR

👤 Contato: ${conversation.userData.name}
🏢 Função: ${conversation.userData.function}
📧 Email: ${conversation.userData.email}
📱 WhatsApp: ${conversation.phoneNumber}

📊 Lead Score: ${conversation.userData.leadScore}/100

---
Sistema SDR WhatsApp - Agendamento Automático
      `.trim(),
      start: {
        dateTime: startTime.toISOString(),
        timeZone: timezone,
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: timezone,
      },
      attendees: [
        { email: process.env.YOUR_EMAIL },
        { email: conversation.userData.email }
      ],
      conferenceData: {
        createRequest: {
          requestId: uuidv4(),
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 24 * 60 }, // 24h antes
          { method: 'email', minutes: 30 },      // 30min antes
          { method: 'popup', minutes: 30 }       // 30min antes
        ]
      }
    };

    const response = await calendar.events.insert({
      calendarId: process.env.CALENDAR_ID || 'primary',
      resource: event,
      conferenceDataVersion: 1,
      sendUpdates: 'all' // Envia convites automaticamente
    });

    logger.info(`✅ Calendar event created for ${conversation.phoneNumber}:`, {
      eventId: response.data.id,
      meetLink: response.data.hangoutLink,
      startTime: startTime.format(),
      attendees: response.data.attendees?.length || 0
    });

    return {
      success: true,
      eventId: response.data.id,
      meetLink: response.data.hangoutLink,
      eventUrl: response.data.htmlLink,
      startTime: startTime.toISOString()
    };

  } catch (error) {
    logger.error('Google Calendar scheduling error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// ============================================================================
// AI PROCESSING ENGINE - COM AGENDAMENTO
// ============================================================================

async function processMessageWithAI(message, conversation) {
  const startTime = Date.now();
  
  try {
    const currentStage = conversation.stage || 'INITIAL';
    const userData = conversation.userData || {};
    
    // Sistema de prompts baseado no estágio atual - com agendamento
    const systemPrompts = {
      'INITIAL': `Você é um assistente SDR profissional. O usuário acabou de enviar a primeira mensagem. Cumprimente de forma calorosa e colete o NOME completo da pessoa. Seja direto mas amigável.`,
      
      'SOLICITAR_NOME': `O usuário precisa fornecer seu nome completo. Se já forneceu, extraia e prossiga pedindo a FUNÇÃO/CARGO na empresa. Se não forneceu nome ainda, insista de forma educada.`,
      
      'SOLICITAR_FUNCAO': `Nome coletado: ${userData.name || 'N/A'}. Agora colete a FUNÇÃO/CARGO da pessoa na empresa. Seja específico sobre o que ela faz profissionalmente.`,
      
      'SOLICITAR_EMAIL': `Nome: ${userData.name || 'N/A'}, Função: ${userData.function || 'N/A'}. Agora colete o EMAIL profissional para contato. Explique que é para enviar material relevante.`,
      
      'OFERECER_AGENDAMENTOS': `Dados coletados - Nome: ${userData.name}, Função: ${userData.function}, Email: ${userData.email}. Agora ofereça opções de agendamento para uma conversa mais detalhada. O usuário pode escolher um horário das opções disponíveis.`,
      
      'AGENDAMENTO_CONFIRMADO': `O agendamento foi confirmado! Seja educado e confirme os detalhes da reunião. Explique que um convite será enviado por email com o link do Google Meet.`
    };

    const prompt = `${systemPrompts[currentStage] || systemPrompts['INITIAL']}

INSTRUÇÕES DE RESPOSTA:
- Seja conciso (máximo 2 frases)
- Use português brasileiro
- Seja profissional mas amigável
- Extraia dados relevantes da mensagem

ANÁLISE REQUERIDA - Responda APENAS com JSON válido:
{
  "intent": "greeting|providing_info|confirming|question|scheduling|selecting_slot|other",
  "extracted_data": {
    "name": "string ou null",
    "function": "string ou null", 
    "email": "string ou null",
    "scheduling_preference": "string ou null",
    "selected_slot": "string ou null"
  },
  "response": "string - resposta para enviar ao usuário",
  "next_stage": "${getNextStage(currentStage)}|${currentStage}",
  "confidence": "number entre 0 e 1",
  "ready_for_n8n": "boolean - se tem dados suficientes para enviar ao N8N",
  "needs_calendar_slots": "boolean - se precisa mostrar horários disponíveis",
  "schedule_meeting": "boolean - se deve agendar reunião agora"
}

MENSAGEM DO USUÁRIO: "${message}"`;

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4-turbo-preview',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 800,
      temperature: 0.3
    });

    const aiResponse = JSON.parse(response.choices[0].message.content);
    const processingTime = Date.now() - startTime;

    return {
      ...aiResponse,
      processing_time: processingTime
    };

  } catch (error) {
    logger.error('AI processing error:', error);
    const processingTime = Date.now() - startTime;
    
    return {
      intent: 'error',
      extracted_data: {},
      response: 'Desculpe, tive um problema técnico. Pode repetir sua mensagem?',
      next_stage: conversation.stage,
      confidence: 0,
      processing_time: processingTime,
      ready_for_n8n: false,
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
// WHATSAPP API INTEGRATION
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
      },
      timeout: 10000
    });

    logger.info(`WhatsApp message sent to ${phoneNumber}: ${message.substring(0, 50)}...`);
    return response.data;

  } catch (error) {
    logger.error('WhatsApp API error:', {
      phone: phoneNumber,
      error: error.response?.data || error.message,
      status: error.response?.status
    });
    throw error;
  }
}

// ============================================================================
// N8N INTEGRATION - COM DADOS DE AGENDAMENTO
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
        interesse_agendamento: conversation.userData?.schedulingPreference || '',
        lead_score: conversation.userData?.leadScore || 0
      },
      
      // 🆕 DADOS DE AGENDAMENTO
      appointmentData: {
        scheduled: conversation.appointment?.scheduled || false,
        eventId: conversation.appointment?.eventId || null,
        meetLink: conversation.appointment?.meetLink || null,
        scheduledDate: conversation.appointment?.scheduledDate || null,
        status: conversation.appointment?.status || 'PENDING'
      },
      
      conversationState: {
        stage: conversation.stage,
        isActive: conversation.metadata?.isActive || false,
        lastActivity: conversation.metadata?.lastActivity,
        messageCount: conversation.messages?.length || 0,
        startedAt: conversation.metadata?.conversationStarted,
        hasAppointment: conversation.appointment?.scheduled || false
      },
      
      extractedData: {
        name: conversation.userData?.name,
        function: conversation.userData?.function,
        email: conversation.userData?.email,
        hasAllRequiredData: !!(conversation.userData?.name && conversation.userData?.function && conversation.userData?.email),
        appointmentScheduled: conversation.appointment?.scheduled || false
      },
      
      channelConfig: {
        channel: 'whatsapp',
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
        businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID
      },
      
      systemData: {
        timestamp: new Date().toISOString(),
        source: 'sdr-backend',
        version: '2.0.0',
        conversationId: conversation._id,
        hasCalendarIntegration: true
      }
    };

    const n8nUrl = process.env.N8N_WEBHOOK_URL || 'https://saffron-app.n8n.cloud/webhook/lead-qualification';
    
    const response = await axios.post(n8nUrl, n8nPayload, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SDR-Backend/2.0.0'
      },
      timeout: 15000
    });

    logger.info(`N8N integration successful for ${conversation.phoneNumber}`, {
      stage: conversation.stage,
      hasAppointment: conversation.appointment?.scheduled || false,
      responseStatus: response.status
    });

    return {
      success: true,
      response: response.data,
      timestamp: new Date()
    };

  } catch (error) {
    logger.error('N8N integration error:', {
      phone: conversation.phoneNumber,
      error: error.response?.data || error.message,
      status: error.response?.status
    });
    
    return {
      success: false,
      error: error.message,
      timestamp: new Date()
    };
  }
}

// ============================================================================
// CORE MESSAGE PROCESSING - COM AGENDAMENTO AUTOMÁTICO
// ============================================================================

async function processIncomingMessage(phoneNumber, messageText, messageId, contactName = '') {
  let conversation = null;
  
  try {
    conversation = await Conversation.findOne({ 
      phoneNumber: phoneNumber,
      'metadata.isActive': true 
    });

    if (!conversation) {
      conversation = new Conversation({
        phoneNumber: phoneNumber,
        contactName: contactName,
        stage: 'INITIAL',
        userData: {},
        appointment: {
          scheduled: false,
          status: 'PENDING'
        },
        messages: [],
        metadata: {
          conversationStarted: new Date(),
          lastActivity: new Date(),
          isActive: true
        }
      });
      
      logger.info(`New conversation started: ${phoneNumber}`);
    }

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

    // Atualiza estágio se necessário
    if (aiResult.next_stage && aiResult.next_stage !== conversation.stage) {
      const oldStage = conversation.stage;
      conversation.stage = aiResult.next_stage;
      logger.info(`Stage transition: ${phoneNumber} ${oldStage} -> ${aiResult.next_stage}`);
    }

    // Calcula lead score
    conversation.userData.leadScore = calculateLeadScore(conversation);

    let finalResponse = aiResult.response;

    // 🆕 LÓGICA DE AGENDAMENTO AUTOMÁTICO
    if (aiResult.needs_calendar_slots && conversation.stage === 'OFERECER_AGENDAMENTOS') {
      const availableSlots = await getAvailableSlots();
      
      if (availableSlots.length > 0) {
        finalResponse += '\n\nHorários disponíveis:\n' + 
          availableSlots.map((slot, index) => `${index + 1}. ${slot.display}`).join('\n') +
          '\n\nDigite o número da opção desejada (ex: 1, 2, 3...)';
      } else {
        finalResponse += '\n\nDesculpe, não há horários disponíveis nos próximos dias. Nossa equipe entrará em contato para agendar.';
      }
    }

    // 🆕 AGENDAR REUNIÃO SE HORÁRIO FOI SELECIONADO
    if (aiResult.schedule_meeting || (conversation.stage === 'OFERECER_AGENDAMENTOS' && aiResult.extracted_data.selected_slot)) {
      try {
        // Extrair slot selecionado da mensagem
        const slotIndex = parseInt(messageText.trim()) - 1;
        const availableSlots = await getAvailableSlots();
        
        if (slotIndex >= 0 && slotIndex < availableSlots.length) {
          const selectedSlot = availableSlots[slotIndex];
          
          // Agenda no Google Calendar
          const schedulingResult = await scheduleGoogleCalendarEvent(conversation, selectedSlot.datetime);
          
          if (schedulingResult.success) {
            // Atualiza dados de agendamento
            conversation.appointment = {
              scheduled: true,
              eventId: schedulingResult.eventId,
              meetLink: schedulingResult.meetLink,
              scheduledDate: new Date(selectedSlot.datetime),
              scheduledTime: selectedSlot.display,
              duration: 30,
              status: 'CONFIRMED',
              remindersSent: {
                day_before: false,
                hour_before: false
              }
            };
            
            conversation.stage = 'AGENDAMENTO_CONFIRMADO';
            
            finalResponse = `✅ Perfeito! Sua reunião está agendada para ${selectedSlot.display}.\n\n` +
              `📧 Você receberá um convite por email com todos os detalhes e o link do Google Meet.\n\n` +
              `📅 Link da reunião: ${schedulingResult.meetLink}\n\n` +
              `Até lá! 😊`;
            
            logger.info(`📅 Meeting scheduled successfully for ${phoneNumber}:`, {
              slot: selectedSlot.display,
              eventId: schedulingResult.eventId,
              meetLink: schedulingResult.meetLink
            });
          } else {
            finalResponse = 'Houve um problema ao agendar sua reunião. Nossa equipe entrará em contato por email para confirmar o horário. 🙏';
          }
        } else {
          finalResponse = 'Por favor, escolha uma opção válida (digite apenas o número: 1, 2, 3...).';
        }
      } catch (schedulingError) {
        logger.error('Scheduling error:', schedulingError);
        finalResponse = 'Houve um problema técnico ao agendar. Nossa equipe entrará em contato por email. 🙏';
      }
    }

    // Adiciona resposta da IA/Sistema
    conversation.messages.push({
      timestamp: new Date(),
      direction: 'OUTGOING',
      content: finalResponse,
      messageId: uuidv4(),
      aiAnalysis: {
        intent: aiResult.intent,
        entities: aiResult.extracted_data,
        confidence: aiResult.confidence,
        processing_time: aiResult.processing_time
      }
    });

    // Atualiza metadata
    conversation.metadata.lastActivity = new Date();

    // Salva conversa
    await conversation.save();

    // Envia resposta via WhatsApp
    await sendWhatsAppMessage(phoneNumber, finalResponse);

    // Integração com N8N
    if (aiResult.ready_for_n8n || conversation.appointment?.scheduled) {
      try {
        const n8nResult = await sendToN8N(conversation);
        conversation.n8nData = {
          sent: n8nResult.success,
          lastSent: new Date(),
          webhookResponse: n8nResult.response
        };
        await conversation.save();
      } catch (n8nError) {
        logger.error('N8N integration failed but continuing:', n8nError.message);
      }
    }

    // Atualiza analytics
    await updateDailyAnalytics();

    return {
      success: true,
      stage: conversation.stage,
      leadScore: conversation.userData.leadScore,
      response: finalResponse,
      n8nIntegrated: conversation.n8nData?.sent || false,
      appointmentScheduled: conversation.appointment?.scheduled || false,
      meetLink: conversation.appointment?.meetLink || null
    };

  } catch (error) {
    logger.error('Message processing error:', {
      phone: phoneNumber,
      error: error.message,
      stack: error.stack
    });

    try {
      await sendWhatsAppMessage(
        phoneNumber, 
        'Desculpe, tive um problema técnico momentâneo. Pode tentar novamente em alguns instantes? 🙏'
      );
    } catch (sendError) {
      logger.error('Failed to send error message:', sendError.message);
    }

    return {
      success: false,
      error: error.message,
      stage: conversation?.stage || 'ERROR'
    };
  }
}

// ============================================================================
// LEAD SCORING SYSTEM - COM AGENDAMENTO
// ============================================================================

function calculateLeadScore(conversation) {
  let score = 0;
  const userData = conversation.userData || {};
  
  // Dados coletados (50 pontos máximo)
  if (userData.name) score += 15;
  if (userData.function) score += 15;  
  if (userData.email) score += 20;
  
  // Engagement (20 pontos máximo)
  const messageCount = conversation.messages?.filter(m => m.direction === 'INCOMING').length || 0;
  score += Math.min(messageCount * 2, 20);
  
  // Progressão no funil (15 pontos máximo)
  const stageScores = {
    'INITIAL': 1,
    'SOLICITAR_NOME': 3,
    'SOLICITAR_FUNCAO': 6,
    'SOLICITAR_EMAIL': 10,
    'OFERECER_AGENDAMENTOS': 12,
    'AGENDAMENTO_CONFIRMADO': 15,
    'COMPLETED': 15
  };
  score += stageScores[conversation.stage] || 0;
  
  // 🆕 BÔNUS AGENDAMENTO (15 pontos máximo)
  if (conversation.appointment?.scheduled) {
    score += 15;
  }
  
  return Math.min(score, 100);
}

// ============================================================================
// ANALYTICS ENGINE - COM MÉTRICAS DE AGENDAMENTO
// ============================================================================

async function updateDailyAnalytics() {
  try {
    const today = moment().tz('America/Sao_Paulo').format('YYYY-MM-DD');
    const todayStart = moment().tz('America/Sao_Paulo').startOf('day').toDate();
    const todayEnd = moment().tz('America/Sao_Paulo').endOf('day').toDate();

    let analytics = await Analytics.findOne({ date: today });
    if (!analytics) {
      analytics = new Analytics({ date: today, metrics: {}, stageBreakdown: {} });
    }

    const [conversations, stageCount] = await Promise.all([
      Conversation.find({
        'metadata.lastActivity': { $gte: todayStart, $lte: todayEnd }
      }),
      Conversation.aggregate([
        {
          $match: {
            'metadata.lastActivity': { $gte: todayStart, $lte: todayEnd }
          }
        },
        {
          $group: {
            _id: '$stage',
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    // Métricas básicas
    analytics.metrics = {
      totalMessages: conversations.reduce((sum, conv) => sum + (conv.messages?.length || 0), 0),
      newConversations: conversations.filter(conv => 
        moment(conv.metadata.conversationStarted).isSame(moment(), 'day')
      ).length,
      completedConversations: conversations.filter(conv => conv.stage === 'COMPLETED').length,
      abandonnedConversations: conversations.filter(conv => conv.stage === 'ABANDONED').length,
      // 🆕 MÉTRICAS DE AGENDAMENTO
      scheduledMeetings: conversations.filter(conv => conv.appointment?.scheduled).length,
      confirmedMeetings: conversations.filter(conv => conv.appointment?.status === 'CONFIRMED').length,
      n8nIntegrations: conversations.filter(conv => conv.n8nData?.sent).length
    };

    // Taxa de conversão
    if (analytics.metrics.newConversations > 0) {
      analytics.metrics.conversionRate = Math.round(
        (analytics.metrics.completedConversations / analytics.metrics.newConversations) * 100
      );
      // 🆕 TAXA DE AGENDAMENTO
      analytics.metrics.schedulingRate = Math.round(
        (analytics.metrics.scheduledMeetings / analytics.metrics.newConversations) * 100
      );
    }

    // Breakdown por estágio
    analytics.stageBreakdown = {
      initial: 0,
      solicitar_nome: 0,
      solicitar_funcao: 0,
      solicitar_email: 0,
      oferecer_agendamentos: 0,
      agendamento_confirmado: 0,
      completed: 0
    };

    stageCount.forEach(stage => {
      const stageKey = stage._id.toLowerCase().replace(/_/g, '_');
      if (analytics.stageBreakdown.hasOwnProperty(stageKey)) {
        analytics.stageBreakdown[stageKey] = stage.count;
      }
    });

    await analytics.save();
    
  } catch (error) {
    logger.error('Analytics update error:', error);
  }
}

// ============================================================================
// API ENDPOINTS - COM ENDPOINTS DE AGENDAMENTO
// ============================================================================

// Health check robusto
app.get('/health', async (req, res) => {
  try {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '2.1.0',
      environment: process.env.NODE_ENV,
      services: {}
    };

    // Testa MongoDB
    try {
      await mongoose.connection.db.admin().ping();
      health.services.mongodb = 'connected';
    } catch (e) {
      health.services.mongodb = 'disconnected';
      health.status = 'degraded';
    }

    // Testa OpenAI
    health.services.openai = process.env.OPENAI_API_KEY ? 'configured' : 'not_configured';
    
    // Testa WhatsApp
    health.services.whatsapp = process.env.WHATSAPP_ACCESS_TOKEN ? 'configured' : 'not_configured';
    
    // Testa N8N
    health.services.n8n = process.env.N8N_WEBHOOK_URL ? 'configured' : 'not_configured';

    // 🆕 TESTA GOOGLE CALENDAR
    try {
      if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REFRESH_TOKEN) {
        await calendar.calendars.get({ calendarId: 'primary' });
        health.services.google_calendar = 'connected';
      } else {
        health.services.google_calendar = 'not_configured';
      }
    } catch (e) {
      health.services.google_calendar = 'error';
      health.status = 'degraded';
    }

    const statusCode = health.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(health);
    
  } catch (error) {
    logger.error('Health check error:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Webhook verification (WhatsApp)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  logger.info('Webhook verification attempt', { mode, token: token?.substring(0, 10) + '...' });

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('✅ Webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    logger.warn('❌ Webhook verification failed');
    res.status(403).send('Forbidden');
  }
});

// Webhook message receiver (WhatsApp)
app.post('/webhook', [
  body('entry').isArray().notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Invalid webhook payload:', errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    const { entry } = req.body;
    
    // Responde imediatamente ao WhatsApp
    res.status(200).json({ status: 'received' });

    // Processa mensagens em background
    for (const entryItem of entry) {
      if (!entryItem.changes) continue;

      for (const change of entryItem.changes) {
        if (change.field !== 'messages') continue;

        const { messages, contacts } = change.value;
        if (!messages) continue;

        for (const message of messages) {
          if (message.type !== 'text') {
            logger.info(`Skipping non-text message: ${message.type}`);
            continue;
          }

          const phoneNumber = message.from;
          const messageText = message.text.body;
          const messageId = message.id;
          
          const contact = contacts?.find(c => c.wa_id === phoneNumber);
          const contactName = contact?.profile?.name || '';

          logger.info(`📱 New message from ${phoneNumber}: ${messageText.substring(0, 100)}...`);

          // Processa mensagem de forma assíncrona
          setImmediate(async () => {
            try {
              await processIncomingMessage(phoneNumber, messageText, messageId, contactName);
            } catch (error) {
              logger.error('Background message processing error:', {
                phone: phoneNumber,
                message: messageText.substring(0, 50),
                error: error.message
              });
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

// 🆕 ENDPOINT PARA GOOGLE CALENDAR AUTH
app.get('/auth/google', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events'
    ],
  });
  res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  
  try {
    const { tokens } = await oauth2Client.getToken(code);
    
    res.json({
      success: true,
      message: 'Configure these tokens in your environment variables:',
      tokens: {
        GOOGLE_REFRESH_TOKEN: tokens.refresh_token,
        GOOGLE_ACCESS_TOKEN: tokens.access_token
      }
    });
  } catch (error) {
    logger.error('Google OAuth error:', error);
    res.status(500).json({ error: 'OAuth failed' });
  }
});

// 🆕 ENDPOINT PARA VERIFICAR SLOTS DISPONÍVEIS
app.get('/calendar/available-slots', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const slots = await getAvailableSlots(parseInt(days));
    
    res.json({
      success: true,
      totalSlots: slots.length,
      slots: slots,
      generated_at: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Available slots error:', error);
    res.status(500).json({ error: 'Failed to get available slots' });
  }
});

// Dashboard endpoint - COM DADOS DE AGENDAMENTO
app.get('/dashboard', async (req, res) => {
  try {
    const today = moment().tz('America/Sao_Paulo').format('YYYY-MM-DD');
    const yesterday = moment().subtract(1, 'day').format('YYYY-MM-DD');

    const [
      activeConversations,
      todayAnalytics,
      yesterdayAnalytics,
      recentActivity,
      stageDistribution,
      upcomingMeetings
    ] = await Promise.all([
      Conversation.countDocuments({ 'metadata.isActive': true }),
      Analytics.findOne({ date: today }),
      Analytics.findOne({ date: yesterday }),
      Conversation.find({ 'metadata.isActive': true })
        .sort({ 'metadata.lastActivity': -1 })
        .limit(10)
        .select('phoneNumber contactName stage userData.name metadata.lastActivity appointment'),
      Conversation.aggregate([
        { $match: { 'metadata.isActive': true } },
        { $group: { _id: '$stage', count: { $sum: 1 } } }
      ]),
      // 🆕 PRÓXIMAS REUNIÕES
      Conversation.find({
        'appointment.scheduled': true,
        'appointment.status': 'CONFIRMED',
        'appointment.scheduledDate': { 
          $gte: new Date(),
          $lte: moment().add(7, 'days').toDate()
        }
      }).sort({ 'appointment.scheduledDate': 1 }).limit(5)
    ]);

    const todayMetrics = todayAnalytics?.metrics || {};
    const yesterdayMetrics = yesterdayAnalytics?.metrics || {};

    const dashboard = {
      metrics: {
        activeConversations,
        todayMessages: todayMetrics.totalMessages || 0,
        todayQualifications: todayMetrics.completedConversations || 0,
        todayScheduledMeetings: todayMetrics.scheduledMeetings || 0,
        todayN8NIntegrations: todayMetrics.n8nIntegrations || 0,
        conversionRate: todayMetrics.conversionRate || 0,
        schedulingRate: todayMetrics.schedulingRate || 0,
        trends: {
          messages: calculateTrend(todayMetrics.totalMessages || 0, yesterdayMetrics.totalMessages || 0),
          qualifications: calculateTrend(todayMetrics.completedConversations || 0, yesterdayMetrics.completedConversations || 0),
          meetings: calculateTrend(todayMetrics.scheduledMeetings || 0, yesterdayMetrics.scheduledMeetings || 0)
        }
      },
      recentActivity: recentActivity.map(conv => ({
        phoneNumber: conv.phoneNumber,
        name: conv.userData?.name || conv.contactName || 'Sem nome',
        stage: conv.stage,
        lastActivity: conv.metadata.lastActivity,
        timeAgo: moment(conv.metadata.lastActivity).fromNow(),
        hasAppointment: conv.appointment?.scheduled || false,
        meetLink: conv.appointment?.meetLink || null
      })),
      stageDistribution: stageDistribution.reduce((acc, stage) => {
        acc[stage._id] = stage.count;
        return acc;
      }, {}),
      upcomingMeetings: upcomingMeetings.map(conv => ({
        name: conv.userData?.name || 'Sem nome',
        phone: conv.phoneNumber,
        scheduledDate: conv.appointment.scheduledDate,
        meetLink: conv.appointment.meetLink,
        timeUntil: moment(conv.appointment.scheduledDate).fromNow()
      }))
    };

    res.json(dashboard);

  } catch (error) {
    logger.error('Dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Resto das funções permanecem iguais...
// Conversas endpoint
app.get('/conversations', async (req, res) => {
  try {
    const { page = 1, limit = 50, stage, active } = req.query;
    
    const filter = {};
    if (stage) filter.stage = stage;
    if (active !== undefined) filter['metadata.isActive'] = active === 'true';

    const conversations = await Conversation.find(filter)
      .sort({ 'metadata.lastActivity': -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .select('-messages');

    const total = await Conversation.countDocuments(filter);

    res.json({
      conversations,
      pagination: {
        current: parseInt(page),
        pages: Math.ceil(total / limit),
        total
      }
    });

  } catch (error) {
    logger.error('Conversations endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Analytics endpoint
app.get('/analytics', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const endDate = moment().tz('America/Sao_Paulo');
    const startDate = endDate.clone().subtract(days - 1, 'days');

    const analytics = await Analytics.find({
      date: {
        $gte: startDate.format('YYYY-MM-DD'),
        $lte: endDate.format('YYYY-MM-DD')
      }
    }).sort({ date: 1 });

    const summary = analytics.reduce((acc, day) => {
      acc.totalMessages += day.metrics.totalMessages || 0;
      acc.newConversations += day.metrics.newConversations || 0;
      acc.completedConversations += day.metrics.completedConversations || 0;
      acc.scheduledMeetings += day.metrics.scheduledMeetings || 0;
      acc.n8nIntegrations += day.metrics.n8nIntegrations || 0;
      return acc;
    }, {
      totalMessages: 0,
      newConversations: 0,
      completedConversations: 0,
      scheduledMeetings: 0,
      n8nIntegrations: 0
    });

    summary.conversionRate = summary.newConversations > 0 
      ? Math.round((summary.completedConversations / summary.newConversations) * 100)
      : 0;
    
    summary.schedulingRate = summary.newConversations > 0 
      ? Math.round((summary.scheduledMeetings / summary.newConversations) * 100)
      : 0;

    res.json({
      summary,
      dailyBreakdown: analytics,
      period: {
        start: startDate.format('YYYY-MM-DD'),
        end: endDate.format('YYYY-MM-DD'),
        days: parseInt(days)
      }
    });

  } catch (error) {
    logger.error('Analytics endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint para testar N8N
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
      },
      appointmentData: {
        scheduled: true,
        eventId: 'test_event_id',
        meetLink: 'https://meet.google.com/test-link',
        status: 'CONFIRMED'
      },
      systemData: {
        timestamp: new Date().toISOString(),
        source: 'test-endpoint',
        version: '2.1.0',
        hasCalendarIntegration: true
      }
    };

    const n8nUrl = process.env.N8N_WEBHOOK_URL || 'https://saffron-app.n8n.cloud/webhook/lead-qualification';
    
    const response = await axios.post(n8nUrl, testData, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });

    res.json({
      success: true,
      n8nResponse: response.data,
      status: response.status,
      url: n8nUrl
    });

  } catch (error) {
    logger.error('N8N test error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      response: error.response?.data
    });
  }
});

// ============================================================================
// DASHBOARD MONITOR HTML - COM AGENDAMENTO
// ============================================================================

app.get('/monitor', (req, res) => {
  const monitorHTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>📅 SDR WhatsApp - Monitor com Agendamento</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #333;
            min-height: 100vh;
            padding: 20px;
        }
        .header {
            text-align: center;
            color: white;
            margin-bottom: 30px;
        }
        .header h1 { font-size: 2.5rem; margin-bottom: 10px; }
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .metric-card {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 15px;
            padding: 20px;
            text-align: center;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
        }
        .metric-icon { font-size: 2rem; margin-bottom: 10px; }
        .metric-value { 
            font-size: 1.8rem; 
            font-weight: bold; 
            margin-bottom: 8px;
            color: #333;
        }
        .metric-label { color: #666; font-size: 0.9rem; }
        .activity-section {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 20px;
        }
        .activity-card {
            background: rgba(255, 255, 255, 0.95);
            border-radius: 15px;
            padding: 20px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
        }
        .activity-item {
            display: flex;
            align-items: center;
            padding: 12px 0;
            border-bottom: 1px solid #eee;
        }
        .activity-avatar {
            width: 35px;
            height: 35px;
            border-radius: 50%;
            background: linear-gradient(135deg, #667eea, #764ba2);
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            margin-right: 12px;
            font-size: 0.8rem;
        }
        .activity-details { flex: 1; }
        .activity-name { font-weight: 600; margin-bottom: 4px; font-size: 0.9rem; }
        .activity-action { color: #666; font-size: 0.8rem; }
        .activity-time { color: #999; font-size: 0.7rem; }
        .meeting-link { 
            color: #4CAF50; 
            text-decoration: none; 
            font-weight: 600; 
            font-size: 0.8rem;
        }
        .meeting-link:hover { text-decoration: underline; }
        .stage-badge {
            padding: 3px 6px;
            border-radius: 8px;
            font-size: 0.6rem;
            font-weight: 600;
            text-transform: uppercase;
        }
        .stage-agendamento_confirmado { background: #e8f5e8; color: #2e7d32; }
        .stage-completed { background: #c8e6c9; color: #2e7d32; }
        .stage-oferecer_agendamentos { background: #fff3e0; color: #f57c00; }
        .refresh-btn {
            position: fixed;
            bottom: 30px;
            right: 30px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 50%;
            width: 60px;
            height: 60px;
            font-size: 1.5rem;
            cursor: pointer;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        }
        .status-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: #4CAF50;
            display: inline-block;
            margin-right: 8px;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
        }
        @media (max-width: 1024px) {
            .activity-section { grid-template-columns: 1fr; }
            .metrics-grid { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>📅 SDR WhatsApp + Agendamento</h1>
        <p><span class="status-dot"></span>Sistema Integrado: N8N + OpenAI + MongoDB + Google Calendar</p>
    </div>

    <div class="metrics-grid">
        <div class="metric-card">
            <div class="metric-icon">💬</div>
            <div class="metric-value" id="messagesCount">-</div>
            <div class="metric-label">Mensagens Hoje</div>
        </div>
        <div class="metric-card">
            <div class="metric-icon">👥</div>
            <div class="metric-value" id="conversationsCount">-</div>
            <div class="metric-label">Conversas Ativas</div>
        </div>
        <div class="metric-card">
            <div class="metric-icon">✅</div>
            <div class="metric-value" id="qualifiedCount">-</div>
            <div class="metric-label">Qualificações</div>
        </div>
        <div class="metric-card">
            <div class="metric-icon">📅</div>
            <div class="metric-value" id="meetingsCount">-</div>
            <div class="metric-label">Reuniões Agendadas</div>
        </div>
        <div class="metric-card">
            <div class="metric-icon">🔗</div>
            <div class="metric-value" id="n8nCount">-</div>
            <div class="metric-label">Integrações N8N</div>
        </div>
        <div class="metric-card">
            <div class="metric-icon">📊</div>
            <div class="metric-value" id="schedulingRate">-</div>
            <div class="metric-label">Taxa Agendamento</div>
        </div>
    </div>

    <div class="activity-section">
        <div class="activity-card">
            <h3>📱 Atividade Recente</h3>
            <div id="activityList">
                <div class="activity-item">
                    <div class="activity-avatar">?</div>
                    <div class="activity-details">
                        <div class="activity-name">Carregando...</div>
                        <div class="activity-action">Conectando...</div>
                    </div>
                </div>
            </div>
        </div>

        <div class="activity-card">
            <h3>🎯 Por Estágio</h3>
            <div id="stagesList">
                <div style="text-align: center; padding: 20px; color: #666;">
                    Carregando...
                </div>
            </div>
        </div>

        <div class="activity-card">
            <h3>📅 Próximas Reuniões</h3>
            <div id="meetingsList">
                <div style="text-align: center; padding: 20px; color: #666;">
                    Carregando...
                </div>
            </div>
        </div>
    </div>

    <button class="refresh-btn" onclick="refreshData()">🔄</button>

    <script>
        async function refreshData() {
            try {
                const response = await fetch('/dashboard');
                const data = await response.json();
                
                // Atualiza métricas
                document.getElementById('messagesCount').textContent = data.metrics.todayMessages || 0;
                document.getElementById('conversationsCount').textContent = data.metrics.activeConversations || 0;
                document.getElementById('qualifiedCount').textContent = data.metrics.todayQualifications || 0;
                document.getElementById('meetingsCount').textContent = data.metrics.todayScheduledMeetings || 0;
                document.getElementById('n8nCount').textContent = data.metrics.todayN8NIntegrations || 0;
                document.getElementById('schedulingRate').textContent = (data.metrics.schedulingRate || 0) + '%';
                
                // Atualiza atividades
                const activityList = document.getElementById('activityList');
                activityList.innerHTML = '';
                
                data.recentActivity.forEach(activity => {
                    const initials = activity.name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
                    const stageClass = 'stage-' + activity.stage.toLowerCase();
                    const appointmentIcon = activity.hasAppointment ? '📅' : '';
                    
                    activityList.innerHTML += \`
                        <div class="activity-item">
                            <div class="activity-avatar">\${initials}</div>
                            <div class="activity-details">
                                <div class="activity-name">\${activity.name} \${appointmentIcon}</div>
                                <div class="activity-action">
                                    <span class="stage-badge \${stageClass}">\${activity.stage}</span>
                                    \${activity.meetLink ? '<a href="' + activity.meetLink + '" target="_blank" class="meeting-link">Link Meet</a>' : ''}
                                </div>
                            </div>
                            <div class="activity-time">\${activity.timeAgo}</div>
                        </div>
                    \`;
                });
                
                // Atualiza distribuição por estágio
                const stagesList = document.getElementById('stagesList');
                stagesList.innerHTML = '';
                
                Object.entries(data.stageDistribution).forEach(([stage, count]) => {
                    const stageClass = 'stage-' + stage.toLowerCase();
                    stagesList.innerHTML += \`
                        <div class="activity-item">
                            <div class="activity-details">
                                <div class="activity-name">
                                    <span class="stage-badge \${stageClass}">\${stage}</span>
                                </div>
                                <div class="activity-action">\${count} conversas</div>
                            </div>
                            <div class="activity-time">\${count}</div>
                        </div>
                    \`;
                });
                
                // Atualiza próximas reuniões
                const meetingsList = document.getElementById('meetingsList');
                meetingsList.innerHTML = '';
                
                if (data.upcomingMeetings && data.upcomingMeetings.length > 0) {
                    data.upcomingMeetings.forEach(meeting => {
                        meetingsList.innerHTML += \`
                            <div class="activity-item">
                                <div class="activity-avatar">📅</div>
                                <div class="activity-details">
                                    <div class="activity-name">\${meeting.name}</div>
                                    <div class="activity-action">
                                        \${meeting.timeUntil}
                                        <a href="\${meeting.meetLink}" target="_blank" class="meeting-link">Entrar</a>
                                    </div>
                                </div>
                            </div>
                        \`;
                    });
                } else {
                    meetingsList.innerHTML = '<div style="text-align: center; padding: 20px; color: #666;">Nenhuma reunião agendada</div>';
                }
                
            } catch (error) {
                console.error('Erro ao atualizar:', error);
            }
        }

        // Auto refresh a cada 30 segundos
        setInterval(refreshData, 30000);
        
        // Carrega dados iniciais
        refreshData();
    </script>
</body>
</html>`;

  res.send(monitorHTML);
});

// ============================================================================
// SCHEDULED TASKS - COM LEMBRETES DE REUNIÃO
// ============================================================================

// Atualiza analytics a cada hora
cron.schedule('0 * * * *', async () => {
  try {
    await updateDailyAnalytics();
    logger.info('✅ Hourly analytics updated');
  } catch (error) {
    logger.error('❌ Analytics update failed:', error);
  }
});

// 🆕 ENVIA LEMBRETES DE REUNIÃO
cron.schedule('0 9,17 * * *', async () => {
  try {
    const tomorrow = moment().add(1, 'day').startOf('day');
    const tomorrowEnd = tomorrow.clone().endOf('day');
    
    // Lembretes 24h antes
    const tomorrowMeetings = await Conversation.find({
      'appointment.scheduled': true,
      'appointment.status': 'CONFIRMED',
      'appointment.scheduledDate': {
        $gte: tomorrow.toDate(),
        $lte: tomorrowEnd.toDate()
      },
      'appointment.remindersSent.day_before': false
    });

    for (const meeting of tomorrowMeetings) {
      const reminderMessage = `📅 Lembrete: Você tem uma reunião agendada amanhã às ${moment(meeting.appointment.scheduledDate).format('HH:mm')}.\n\n` +
        `🔗 Link: ${meeting.appointment.meetLink}\n\n` +
        `Nos vemos lá! 😊`;
      
      try {
        await sendWhatsAppMessage(meeting.phoneNumber, reminderMessage);
        meeting.appointment.remindersSent.day_before = true;
        await meeting.save();
        logger.info(`📅 24h reminder sent to ${meeting.phoneNumber}`);
      } catch (error) {
        logger.error(`Failed to send 24h reminder to ${meeting.phoneNumber}:`, error);
      }
    }

    // Lembretes 1h antes
    const oneHourFromNow = moment().add(1, 'hour');
    const oneHourMeetings = await Conversation.find({
      'appointment.scheduled': true,
      'appointment.status': 'CONFIRMED',
      'appointment.scheduledDate': {
        $gte: oneHourFromNow.clone().subtract(5, 'minutes').toDate(),
        $lte: oneHourFromNow.clone().add(5, 'minutes').toDate()
      },
      'appointment.remindersSent.hour_before': false
    });

    for (const meeting of oneHourMeetings) {
      const reminderMessage = `⏰ Sua reunião começará em aproximadamente 1 hora!\n\n` +
        `🔗 Link direto: ${meeting.appointment.meetLink}\n\n` +
        `Já pode entrar na sala virtual. Até já! 👋`;
      
      try {
        await sendWhatsAppMessage(meeting.phoneNumber, reminderMessage);
        meeting.appointment.remindersSent.hour_before = true;
        await meeting.save();
        logger.info(`⏰ 1h reminder sent to ${meeting.phoneNumber}`);
      } catch (error) {
        logger.error(`Failed to send 1h reminder to ${meeting.phoneNumber}:`, error);
      }
    }

    logger.info(`📅 Reminder task completed: ${tomorrowMeetings.length + oneHourMeetings.length} reminders processed`);
  } catch (error) {
    logger.error('❌ Reminder task failed:', error);
  }
});

// Limpa conversas inativas diariamente às 2:00
cron.schedule('0 2 * * *', async () => {
  try {
    const cutoff = moment().subtract(7, 'days').toDate();
    
    const result = await Conversation.updateMany(
      {
        'metadata.isActive': true,
        'metadata.lastActivity': { $lt: cutoff },
        stage: { $nin: ['COMPLETED', 'ABANDONED', 'AGENDAMENTO_CONFIRMADO'] }
      },
      {
        $set: {
          stage: 'ABANDONED',
          'metadata.isActive': false
        }
      }
    );

    logger.info(`🧹 Marked ${result.modifiedCount} conversations as abandoned`);
  } catch (error) {
    logger.error('❌ Cleanup task failed:', error);
  }
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((err, req, res, next) => {
  logger.error('Unhandled error:', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method
  });
  
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `Route ${req.method} ${req.originalUrl} not found`
  });
});

// ============================================================================
// SERVER INITIALIZATION
// ============================================================================

async function startServer() {
  try {
    // Conecta MongoDB
    await connectMongoDB();
    
    // Atualiza analytics inicial
    await updateDailyAnalytics();
    logger.info('📊 Initial analytics updated');
    
    // Inicia servidor
    const server = app.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 SDR WhatsApp + Calendar Server running on port ${PORT}`);
      logger.info(`🔗 Webhook URL: ${process.env.BASE_URL || \`http://localhost:\${PORT}\`}/webhook`);
      logger.info(`📅 Calendar Auth: ${process.env.BASE_URL || \`http://localhost:\${PORT}\`}/auth/google`);
      logger.info(`📊 Monitor URL: ${process.env.BASE_URL || \`http://localhost:\${PORT}\`}/monitor`);
      logger.info(`💚 Health Check: ${process.env.BASE_URL || \`http://localhost:\${PORT}\`}/health`);
      logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`📅 Google Calendar: ${process.env.GOOGLE_CLIENT_ID ? 'CONFIGURED' : 'NOT CONFIGURED'}`);
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info(\`\${signal} received, starting graceful shutdown...\`);
      
      server.close(async () => {
        try {
          await mongoose.connection.close();
          logger.info('📊 MongoDB connection closed');
          process.exit(0);
        } catch (error) {
          logger.error('❌ Error during shutdown:', error);
          process.exit(1);
        }
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.error('❌ Server startup failed:', error);
    process.exit(1);
  }
}

// Error handlers
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection:', { reason, promise });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

// Start server
startServer(); 

    
