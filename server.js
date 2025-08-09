import 'dotenv/config';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

// --- μ-law helpers ---
const MULAW_BIAS = 0x84;
function mulawDecode(mu) {
  mu = ~mu & 0xFF;
  const sign = (mu & 0x80) ? -1 : 1;
  let exp = (mu >> 4) & 0x07;
  let man = mu & 0x0F;
  let sample = ((man << 4) + 0x08) << (exp + 3);
  sample -= MULAW_BIAS;
  return sign * sample;
}
function mulawEncode(pcm) {
  const sign = pcm < 0 ? 0x80 : 0x00;
  pcm = Math.abs(pcm) + MULAW_BIAS;
  if (pcm > 0x7FFF) pcm = 0x7FFF;
  let exp = 7;
  for (let m = 0x4000; (pcm & m) === 0 && exp > 0; m >>= 1) exp--;
  const man = (pcm >> ((exp === 0) ? 4 : (exp + 3))) & 0x0F;
  return ~(sign | (exp << 4) | man) & 0xFF;
}
// --- linear resampler ---
function resampleLinear(int16, fromRate, toRate) {
  if (fromRate === toRate) return int16;
  const ratio = toRate / fromRate;
  const outLen = Math.floor(int16.length * ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, int16.length - 1);
    const frac = src - i0;
    out[i] = (int16[i0] * (1 - frac) + int16[i1] * frac) | 0;
  }
  return out;
}

const server = http.createServer();
const wss = new WebSocketServer({ server, path: '/ws/twilio' });

function connectOpenAI() {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(process.env.OPENAI_REALTIME_MODEL)}`;
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' };
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

wss.on('connection', async (twilio, req) => {
  console.log('Twilio WS connected from', req.socket.remoteAddress);
  let openai;
  try { openai = await connectOpenAI(); }
  catch (e) { console.error('OpenAI connect error:', e?.message || e); twilio.close(); return; }

  openai.on('open', () => {
    console.log('OpenAI WS opened');
    const instructions = `Ти си кратък гласов асистент за градски транспорт в България.
Говори на езика на обаждащия. Питай откъде, докъде, кога.
Кратки изречения. Предложи такси при нужда.
Накрая попитай: "Да изпратя ли маршрута по SMS?" и "Да извикам ли такси?"`;
    openai.send(JSON.stringify({ type: 'session.update', session: { instructions } }));
  });

  let twilioStreamSid = null;
  let chunkCounter = 0;

  // Twilio -> OpenAI
  twilio.on('message', (raw) => {
    try {
      const evt = JSON.parse(raw.toString('utf8'));
      if (evt.event === 'start') {
        twilioStreamSid = evt.start.streamSid;
        console.log('Twilio start streamSid:', twilioStreamSid);
      } else if (evt.event === 'media') {
        const ulaw = Buffer.from(evt.media.payload, 'base64');
        const pcm16_8k = new Int16Array(ulaw.length);
        for (let i = 0; i < ulaw.length; i++) pcm16_8k[i] = mulawDecode(ulaw[i]);
        const pcm16_16k = resampleLinear(pcm16_8k, 8000, 16000);
        const buf = Buffer.alloc(pcm16_16k.length * 2);
        for (let i = 0; i < pcm16_16k.length; i++) buf.writeInt16LE(pcm16_16k[i], i * 2);
        openai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: buf.toString('base64') }));
        chunkCounter++;
        // Every ~15 media chunks (~0.5-1s), flush and request a response
        if (chunkCounter % 15 === 0) {
          openai.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          openai.send(JSON.stringify({ type: 'response.create', response: { modalities: ['audio','text'] } }));
        }
      } else if (evt.event === 'stop') {
        console.log('Twilio stop');
        openai.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        openai.send(JSON.stringify({ type: 'response.create', response: { modalities: ['audio','text'] } }));
      }
    } catch (e) {
      console.error('Twilio msg parse error:', e);
    }
  });

  // OpenAI -> Twilio
  openai.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString('utf8'));
      // Support both possible event keys
      const isDelta = (msg.type === 'response.audio.delta' || msg.type === 'response.output_audio.delta');
      if (isDelta && msg.audio) {
        const pcmBuf = Buffer.from(msg.audio, 'base64');
        const samples = pcmBuf.length / 2;
        const pcm16_16k = new Int16Array(samples);
        for (let i = 0; i < samples; i++) pcm16_16k[i] = pcmBuf.readInt16LE(i * 2);
        const pcm16_8k = resampleLinear(pcm16_16k, 16000, 8000);
        const ulaw = Buffer.alloc(pcm16_8k.length);
        for (let i = 0; i < pcm16_8k.length; i++) ulaw[i] = mulawEncode(pcm16_8k[i]);
        const frame = { event: 'media', streamSid: twilioStreamSid || '', media: { payload: ulaw.toString('base64') } };
        if (twilio.readyState === WebSocket.OPEN) twilio.send(JSON.stringify(frame));
      }
      if (msg.type === 'response.completed') {
        // Keep the turn going: wait for more user audio
        chunkCounter = 0;
      }
      if (msg.type === 'error') {
        console.error('OpenAI error:', msg);
      }
    } catch (e) {
      console.error('OpenAI msg parse error:', e);
    }
  });

  const bye = () => { try { twilio.close(); } catch {} try { openai.close(); } catch {} };
  twilio.on('close', () => { console.log('Twilio WS closed'); bye(); });
  openai.on('close', () => { console.log('OpenAI WS closed'); bye(); });

  twilio.on('error', (e) => console.error('Twilio WS error:', e?.message || e));
  openai.on('error', (e) => console.error('OpenAI WS error:', e?.message || e));
});

const PORT = process.env.PORT;
server.listen(PORT, '0.0.0.0', () => console.log('WS proxy on :' + PORT));
