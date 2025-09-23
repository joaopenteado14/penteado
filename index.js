const express = require('express');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS headers para Meta
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Verificação webhook (GET)
app.get('/webhook/whatsapp', (req, res) => {
  console.log('📞 Verificação webhook recebida:', req.query);
  
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (mode === 'subscribe' && token === 'meutoken123') {
    console.log('✅ Webhook verificado!');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Falha na verificação:', { mode, token });
    res.status(403).send('Forbidden');
  }
});

// Receber mensagens (POST)
app.post('/webhook/whatsapp', (req, res) => {
  console.log('📱 Mensagem:', req.body);
  res.status(200).send('OK');
});

app.get('/', (req, res) => {
  res.send('🚀 Webhook funcionando no Render!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Servidor rodando na porta ${PORT}`);
});
