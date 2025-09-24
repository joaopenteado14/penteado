const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Configurações do WhatsApp Business API
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || 'seu_token_aqui';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'meutoken123';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || 'seu_phone_number_id';

// Rota para verificação do webhook (GET)
app.get('/webhook/whatsapp', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('Verificação do webhook:', { mode, token, challenge });

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('Webhook verificado com sucesso!');
        res.status(200).send(challenge);
    } else {
        console.log('Falha na verificação do webhook');
        res.sendStatus(403);
    }
});

// Rota para receber mensagens do WhatsApp (POST)
app.post('/webhook/whatsapp', async (req, res) => {
    console.log('Webhook recebido:', JSON.stringify(req.body, null, 2));

    try {
        const body = req.body;

        if (body.object === 'whatsapp_business_account') {
            if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
                const message = body.entry[0].changes[0].value.messages[0];
                const from = message.from;
                const messageBody = message.text?.body || '';

                console.log(`Mensagem recebida de ${from}: ${messageBody}`);

                // Resposta automática simples
                let responseMessage = 'Obrigado pela sua mensagem! Nossa equipe entrará em contato em breve.';
                
                if (messageBody.toLowerCase().includes('oi') || messageBody.toLowerCase().includes('olá')) {
                    responseMessage = 'Olá! Como posso te ajudar hoje?';
                }

                console.log(`Enviando resposta: ${responseMessage}`);
            }
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('Erro no webhook:', error);
        res.status(500).send('Erro interno do servidor');
    }
});

// Rota de teste
app.get('/', (req, res) => {
    res.json({
        message: 'Webhook WhatsApp está funcionando!',
        timestamp: new Date().toISOString(),
        status: 'online'
    });
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Webhook WhatsApp configurado`);
});

module.exports = app;
