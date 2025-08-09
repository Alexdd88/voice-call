import 'dotenv/config';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const server = http.createServer();
const wss = new WebSocketServer({ server, path: '/ws/twilio' });

function connectOpenAI() {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(process.env.OPENAI_REALTIME_MODEL)}`;
  const headers = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'OpenAI-Beta': 'realtime=v1'
  };
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

wss.on('connection', async (twilio) => {
  let openai;
  try { openai = await connectOpenAI(); } catch (e) { twilio.close(); return; }

  openai.on('message', (msg) => {
    if (twilio.readyState === WebSocket.OPEN) twilio.send(msg);
  });
  twilio.on('message', (msg) => {
    if (openai.readyState === WebSocket.OPEN) openai.send(msg);
  });

  const bye = () => { try { twilio.close(); } catch {} try { openai.close(); } catch {} };
  openai.on('close', bye);
  twilio.on('close', bye);

  const instructions = `Ти си кратък гласов асистент за градски транспорт в България.
Говори на езика на обаждащия.
Питай откъде, докъде, кога. Кратки изречения.
Предложи такси при нужда.
Накрая попитай за SMS и такси.`;
  openai.send(JSON.stringify({ type: 'session.update', session: { instructions } }));
});

const PORT = process.env.PORT;
server.listen(PORT, '0.0.0.0', () => console.log('WS proxy on :' + PORT));


