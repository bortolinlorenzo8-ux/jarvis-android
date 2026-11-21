import { PorcupineWorker, BuiltInKeyword } from '@picovoice/porcupine-web';
import { TextToSpeech } from '@capacitor-community/text-to-speech';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => localStorage.getItem(k) || '',
  set: (k, v) => localStorage.setItem(k, v),
};

const MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite'];
const TIMEOUT_MS = 14000;

const SYSTEM = `Sei J.A.R.V.I.S., il maggiordomo AI di Tony Stark, e vivi nel telefono del tuo padrone.
Ricevi la richiesta come audio in italiano. Rispondi in italiano con UNA sola frase secca, massimo 20 parole.
Tono britannico, flemmatico, ironia asciutta. Se la richiesta e' sciocca, sii sarcastico.
Termina SEMPRE con la parola "signore", senza virgola prima, senza punto esclamativo, senza puntini di sospensione.
Niente markdown, niente emoji, niente elenchi, niente indirizzi web.
Usa la ricerca web per notizie, meteo, sport e dati attuali.
Se chiede un timer o un promemoria a breve scadenza, inizia la risposta con il marcatore [[TIMER:secondi]] (numero di secondi) e poi conferma.
Non dichiarare di aver eseguito azioni che non puoi fare: per ora sai rispondere, cercare sul web e impostare timer.
Se l'audio e' incomprensibile, chiedi di ripetere in poche parole.`;

// ------------------------------------------------------------------ stato
let running = false;
let state = 'off'; // off | idle | listening | busy | speaking
let level = 0;
let noise = 0.005;
let history = [];

let porcupine = null, ctx = null, proc = null, stream = null, wakeLock = null;
let pend = [];
let rec = [], heard = false, silent = 0, tStart = 0, noSpeechLimit = 5000;

const LABELS = {
  off: 'OFFLINE', idle: 'ONLINE · DI\' "JARVIS"', listening: 'ASCOLTO',
  busy: 'ELABORAZIONE', speaking: 'PARLA',
};

function setState(s) {
  if (!running && s !== 'off') return;
  state = s;
  $('status').textContent = LABELS[s];
}

function log(who, text, cls = '') {
  const d = document.createElement('div');
  d.className = 'l ' + cls;
  const b = document.createElement('b');
  b.textContent = who + ' ';
  d.append(b, document.createTextNode(text));
  $('log').append(d);
  while ($('log').children.length > 6) $('log').firstChild.remove();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// ------------------------------------------------------------- avvio/stop
function greeting() {
  const h = new Date().getHours();
  const p = h < 6 ? 'Buonanotte' : h < 13 ? 'Buongiorno' : h < 18 ? 'Buon pomeriggio' : 'Buonasera';
  return `${p} signore. Sistemi in linea e a sua disposizione`;
}

async function start() {
  const gk = store.get('gemini'), pk = store.get('pico');
  if (!gk || !pk) { openSettings(); return; }
  $('go').disabled = true;
  running = true;
  setState('busy');
  $('status').textContent = 'AVVIO…';
  try {
    porcupine = await PorcupineWorker.create(
      pk, [BuiltInKeyword.Jarvis], onWake, { publicPath: 'porcupine_params.pv' });
    await openMic();
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
    log('J.A.R.V.I.S.', greeting());
    await speak(greeting());
    setState('idle');
    $('go').textContent = 'FERMA';
    $('go').disabled = false;
  } catch (e) {
    log('ERRORE', String(e && e.message ? e.message : e), 'err');
    await stop();
  }
}

async function stop() {
  running = false;
  setState('off');
  try { TextToSpeech.stop(); } catch (_) {}
  try { if (proc) proc.disconnect(); } catch (_) {}
  try { if (ctx) await ctx.close(); } catch (_) {}
  try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  try { if (porcupine) porcupine.terminate(); } catch (_) {}
  try { if (wakeLock) await wakeLock.release(); } catch (_) {}
  porcupine = ctx = proc = stream = wakeLock = null;
  pend = []; rec = [];
  $('go').textContent = 'AVVIA';
  $('go').disabled = false;
}

// ------------------------------------------------------------- microfono
async function openMic() {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  ctx = new AudioContext({ sampleRate: 16000 });
  const src = ctx.createMediaStreamSource(stream);
  proc = ctx.createScriptProcessor(2048, 1, 1);
  proc.onaudioprocess = (e) => onAudio(e.inputBuffer.getChannelData(0));
  src.connect(proc);
  proc.connect(ctx.destination);
}

function onAudio(input) {
  if (!running || !ctx) return;
  const ratio = ctx.sampleRate / 16000;
  const n = Math.floor(input.length / ratio);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio, i0 = Math.floor(pos), i1 = Math.min(i0 + 1, input.length - 1);
    const s = input[i0] * (1 - (pos - i0)) + input[i1] * (pos - i0);
    pend.push(Math.max(-1, Math.min(1, s)) * 32767 | 0);
  }
  while (pend.length >= 512) onFrame(Int16Array.from(pend.splice(0, 512)));
}

function onFrame(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length) / 32768;
  level = Math.min(1, rms * 8);

  if (state === 'idle') {
    noise = Math.min(0.03, noise * 0.97 + rms * 0.03);
    try { porcupine.process(frame); } catch (_) {}
  } else if (state === 'listening') {
    rec.push(frame);
    const th = Math.max(0.012, noise * 3);
    if (rms > th) { heard = true; silent = 0; } else if (heard) silent += 32;
    const el = Date.now() - tStart;
    if ((heard && silent >= 1100) || el > 15000) finish();
    else if (!heard && el > noSpeechLimit) setState('idle');
  }
}

function onWake() {
  if (state === 'idle') listen(false);
}

function listen(follow) {
  rec = []; heard = false; silent = 0; tStart = Date.now();
  noSpeechLimit = follow ? 6000 : 5000;
  setState('listening');
}

function finish() {
  const frames = rec;
  rec = [];
  setState('busy');
  handle(wavBase64(frames)).catch((e) => {
    log('ERRORE', String(e && e.message ? e.message : e), 'err');
    setState('idle');
  });
}

function wavBase64(frames) {
  let n = 0;
  for (const f of frames) n += f.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (const f of frames) for (let i = 0; i < f.length; i++) { v.setInt16(o, f[i], true); o += 2; }
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------------------------------------------------------------- Gemini
async function callGemini(model, contents, useThink, useSearch) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM + '\nOra: ' + new Date().toLocaleString('it-IT') }] },
    contents,
    generationConfig: { maxOutputTokens: 220, temperature: 0.7 },
  };
  if (useThink) body.generationConfig.thinkingConfig = { thinkingLevel: 'minimal' };
  if (useSearch) body.tools = [{ google_search: {} }];
  const r = await withTimeout(fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': store.get('gemini') },
      body: JSON.stringify(body),
    }), TIMEOUT_MS);
  if (!r.ok) throw new Error(`${model} ${r.status}`);
  const data = await r.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content.parts) || [];
  const text = parts.filter((p) => p.text).map((p) => p.text).join(' ').trim();
  if (!text) throw new Error(`${model} risposta vuota`);
  return text;
}

async function askGemini(b64) {
  const userTurn = {
    role: 'user',
    parts: [{ inlineData: { mimeType: 'audio/wav', data: b64 } }, { text: '(rispondi alla richiesta nell\'audio)' }],
  };
  const contents = [...history, userTurn];
  const attempts = [
    [MODELS[0], true, true], [MODELS[0], false, true], [MODELS[0], false, false],
    [MODELS[1], false, false],
  ];
  let last = null;
  for (const [model, think, search] of attempts) {
    try {
      const text = await callGemini(model, contents, think, search);
      history.push(userTurn, { role: 'model', parts: [{ text }] });
      history = history.slice(-6);
      return text;
    } catch (e) { last = e; }
  }
  throw last || new Error('Gemini non risponde');
}

function speakable(t) {
  return t
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\[\d+(?:,\s*\d+)*\]/g, ' ')
    .replace(/[*_#`>]/g, ' ')
    .replace(/\s*,\s*(signore|signora)\b[.!]*/gi, ' $1')
    .replace(/!/g, '.').replace(/\.\.\.|…/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// -------------------------------------------------------------- risposta
async function handle(b64) {
  let reply, ok = true;
  try {
    reply = await askGemini(b64);
  } catch (e) {
    ok = false;
    log('ERRORE', String(e.message || e), 'err');
    reply = 'Non riesco a contattare i miei sistemi signore';
  }
  const m = reply.match(/\[\[TIMER:(\d+)\]\]/);
  reply = speakable(reply.replace(/\[\[TIMER:\d+\]\]/g, ''));
  if (!reply) reply = 'Non ho capito signore';
  if (m) setTimer(parseInt(m[1], 10));
  log('J.A.R.V.I.S.', reply);
  await speak(reply);
  if (!running) return;
  if (ok) { await sleep(600); if (running) listen(true); } else setState('idle');
}

async function speak(text) {
  setState('speaking');
  try {
    await TextToSpeech.speak({ text, lang: 'it-IT', rate: 1.0, pitch: 0.85, volume: 1.0 });
  } catch (e) {
    await new Promise((res) => {
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'it-IT'; u.pitch = 0.85; u.onend = res; u.onerror = res;
        speechSynthesis.speak(u);
      } catch (_) { res(); }
    });
  }
}

function setTimer(sec) {
  setTimeout(async () => {
    while (running && state !== 'idle') await sleep(700);
    if (!running) return;
    setState('busy');
    log('J.A.R.V.I.S.', 'Timer scaduto');
    await speak('Il timer è scaduto signore');
    setState('idle');
  }, sec * 1000);
}

// ------------------------------------------------------------ impostazioni
function openSettings() {
  $('k1').value = store.get('gemini');
  $('k2').value = store.get('pico');
  $('set').style.display = 'block';
}
$('cfg').onclick = openSettings;
$('close').onclick = () => { $('set').style.display = 'none'; };
$('save').onclick = () => {
  store.set('gemini', $('k1').value.trim());
  store.set('pico', $('k2').value.trim());
  $('set').style.display = 'none';
};
$('go').onclick = () => (running ? stop() : start());
if (!store.get('gemini') || !store.get('pico')) openSettings();

// -------------------------------------------------------------------- HUD
const cv = $('hud'), g = cv.getContext('2d');
function resize() {
  const d = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = innerWidth * d; cv.height = innerHeight * d;
}
addEventListener('resize', resize); resize();

const COLORS = { off: '#2a5a6e', idle: '#00d4ff', listening: '#3dffb0', busy: '#ffb020', speaking: '#7ec8ff' };
let t = 0;
function draw() {
  requestAnimationFrame(draw);
  t += 0.016;
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H * 0.36, R = Math.min(W, H) * 0.34;
  const col = COLORS[state] || COLORS.off;
  const p = state === 'listening' ? level
    : state === 'speaking' ? 0.5 + 0.5 * Math.sin(t * 9)
    : state === 'busy' ? 0.5 + 0.5 * Math.sin(t * 5)
    : 0.15 + 0.15 * Math.sin(t * 2);

  const gr = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.6);
  gr.addColorStop(0, col + 'cc'); gr.addColorStop(0.35, col + '33'); gr.addColorStop(1, col + '00');
  g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, R * (0.6 + p * 0.1), 0, 7); g.fill();

  g.strokeStyle = col; g.shadowColor = col; g.shadowBlur = 12 * (W / 1000 + 0.5);
  for (let i = 0; i < 5; i++) {
    const r = R * (0.38 + i * 0.15) * (1 + p * 0.03 * i);
    g.lineWidth = (2 + (i % 2)) * (W / 900 + 0.4);
    g.globalAlpha = 0.9 - i * 0.12;
    g.setLineDash(i % 2 ? [r * 0.35, r * 0.12] : [r * 0.9, r * 0.2, r * 0.1, r * 0.2]);
    const dir = i % 2 ? 1 : -1;
    g.beginPath(); g.arc(cx, cy, r, t * dir * (0.4 + i * 0.25), t * dir * (0.4 + i * 0.25) + 6.283); g.stroke();
  }
  g.setLineDash([]); g.globalAlpha = 1; g.shadowBlur = 0;
}
draw();
