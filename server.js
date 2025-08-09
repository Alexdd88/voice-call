import 'dotenv/config';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const MULAW_BIAS = 0x84;
function mulawDecode(mu) {
  mu = ~mu & 0xFF;
  const sign = (mu & 0x80) ? -1 : 1;
  let exponent = (mu >> 4) & 0x07;
  let mantissa = mu & 0x0F;
  let sample = ((mantissa << 4) + 0x08) << (exponent + 3);
  sample -= MULAW_BIAS;
  return sign * sample;
}
function mulawEncode(pcm) {
  const sign = pcm < 0 ? 0x80 : 0x00;
  pcm = Math.abs(pcm) + MULAW_BIAS;
  if (pcm > 0x7FFF) pcm = 0x7FFF;
  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; expMask >>= 1) exponent--;
  const mantissa = (pcm >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}
function resampleLinear(int16Array, fromRate, toRate) {
  if (fromRate === toRate) return int16Array;
  const ratio = toRate / fromRate;
  const outLength = Math.floor(int16Array.length * ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIndex = i / ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, int16Array.length - 1);
    const frac = srcIndex - i0;
    out[i] = (int16Array[i0] * (1 - frac) + int16Array[i1] * frac) | 0;
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

wss.on('connection', async (twilio) => {
  let openai;
  try { openai = await connectOpenAI(); } catch (e) { console.error('OpenAI connect error', e); twilio.close(); return; }

  openai.on('open', () => {
    const instructions = `Ти си кратък гласов асистент за градски транспорт в България.
Говори на езика на обаждащия. Питай откъде, докъде, кога.
Кратки изречения. Предложи такси при нужда.
Накрая попитай: "Да изпратя ли маршрута по SMS?" и "Да извикам ли такси?"`;
    openai.send(JSON.stringify({ type: 'session.update', session: { instructions } }));
  });

  twilio.on('message', (raw) => {
    try {
      const evt = JSON.parse(raw.toString('utf8'));
      switch (evt.event) {
        case 'start':
          break;
        case 'media':
          const ulaw = Buffer.from(evt.media.payload, 'base64');
          const pcm16_8k = new Int16Array(ulaw.length);
          for (let i = 0; i < ulaw.length; i++) pcm16_8k[i] = mulawDecode(ulaw[i]);
          const pcm16_16k = resampleLinear(pcm16_8k, 8000, 16000);
          const buf = Buffer.alloc(pcm16_16k.length * 2);
          for (let i = 0; i < pcm16_16k.length; i++) buf.writeInt16LE(pcm16_16k[i], i * 2);
          openai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: buf.toString('base64') }));
          break;
        case 'stop':
          openai.send(JSON.stringify({ type: 'response.create', response: { modalities: ['audio','text'] } }));
          break;
      }
    } catch (e) { console.error('Twilio msg err', e); }
  });

  let twilioStreamSid = null;
  let pendingAudio = [];
  twilio.on('message', (raw) => {
    try {
      const evt = JSON.parse(raw.toString('utf8'));
      if (evt.event === 'start') {
        twilioStreamSid = evt.start.streamSid;
        while (pendingAudio.length) {
          twilio.send(JSON.stringify(pendingAudio.shift()));
        }
      }
    } catch {}
  });

  openai.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.type === 'response.audio.delta' && msg.audio) {
        const pcmBuf = Buffer.from(msg.audio, 'base64');
        const pcm16_16k = new Int16Array(pcmBuf.length / 2);
        for (let i = 0; i < pcm16_16k.length; i++) pcm16_16k[i] = pcmBuf.readInt16LE(i * 2);
        const pcm16_8k = resampleLinear(pcm16_16k, 16000, 8000);
        const ulaw = Buffer.alloc(pcm16_8k.length);
        for (let i = 0; i < pcm16_8k.length; i++) ulaw[i] = mulawEncode(pcm16_8k[i]);
        const frame = {
          event: 'media',
          streamSid: twilioStreamSid || '',
          media: { payload: ulaw.toString('base64') }
        };
        if (twilioStreamSid) twilio.send(JSON.stringify(frame));
        else pendingAudio.push(frame);
      }
    } catch (e) { console.error('OpenAI msg err', e); }
  });

  const bye = () => { try { twilio.close(); } catch {} try { openai.close(); } catch {} };
  twilio.on('close', bye);
  openai.on('close', bye);
});

const PORT = process.env.PORT;
server.listen(PORT, '0.0.0.0', () => console.log('WS proxy on :' + PORT));
