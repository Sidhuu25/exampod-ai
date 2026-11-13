// Vercel Serverless Function: POST /api/generate
// Environment variables (Vercel > Project > Settings > Environment Variables):
//   AI_API_KEYS  comma-separated keys, up to 50. Groq keys start with gsk_, OpenRouter keys with sk-or-
//   CODE_29, CODE_59, CODE_99   (optional) change the unlock codes. Defaults: SPRINT29, TOPPER59, VIP99
const crypto = require('crypto');

const URLS = { groq: 'https://api.groq.com/openai/v1', or: 'https://openrouter.ai/api/v1' };
const SKIP = /whisper|tts|playai|orpheus|guard|embed|safeguard|vision|image|audio|moderation/i;
const PREF = {
  groq: [/llama-3\.3-70b/, /gpt-oss-120b/, /qwen/, /llama-4/, /llama-3\.1-8b/, /gemma/, /llama/],
  or: [/llama-3\.3-70b/, /qwen/, /gemma/, /deepseek/, /llama/, /mistral/]
};
const FALLBACK = {
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it'],
  or: ['meta-llama/llama-3.3-70b-instruct:free', 'google/gemma-3-27b-it:free']
};
const DEFAULT_CODES = { '29': 'SPRINT29', '59': 'TOPPER59', '99': 'VIP99' };

let cache = {};          // model lists per provider, refreshed hourly
const hits = new Map();  // best-effort rate limit per IP (resets when the instance restarts)

function limited(id, max, windowMs) {
  const now = Date.now();
  const h = (hits.get(id) || []).filter(t => now - t < windowMs);
  h.push(now);
  hits.set(id, h);
  if (hits.size > 5000) hits.clear();
  return h.length > max;
}

function parseKeys() {
  const seen = new Set();
  return String(process.env.AI_API_KEYS || '')
    .split(/[,\n]/).map(k => k.trim())
    .filter(k => /^(gsk_|sk-or-)/.test(k) && !seen.has(k) && seen.add(k))
    .slice(0, 50)
    .map(k => ({ k, p: k.startsWith('gsk_') ? 'groq' : 'or', id: '...' + k.slice(-4) }));
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rank(ids, pref) {
  return ids
    .map((id, i) => { const k = pref.findIndex(re => re.test(id)); return { id, k: k < 0 ? 99 : k, i }; })
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map(x => x.id);
}

async function modelsFor(p, key) {
  const c = cache[p];
  if (c && Date.now() - c.t < 3600e3) return c.list;
  let list = [];
  try {
    if (p === 'groq') {
      const r = await fetch(URLS.groq + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      list = rank((d.data || []).filter(m => m.active !== false && !SKIP.test(m.id)).map(m => m.id), PREF.groq);
    } else {
      const r = await fetch(URLS.or + '/models', { signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      list = rank((d.data || [])
        .filter(m => /:free$/.test(m.id) && !SKIP.test(m.id) && (m.architecture?.input_modalities || ['text']).includes('text') && (m.architecture?.output_modalities || ['text']).includes('text'))
        .map(m => m.id), PREF.or);
    }
  } catch (e) { /* fall back below */ }
  if (!list.length) list = FALLBACK[p];
  cache[p] = { t: Date.now(), list: list.slice(0, 3) };
  return cache[p].list;
}

function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

  // ---- Unlock code check (codes stay on the server, not in the page source) ----
  if (b.action === 'unlock') {
    if (limited('u' + ip, 10, 10 * 60e3)) return res.status(429).json({ error: 'Too many wrong tries. Please wait 10 minutes.' });
    const code = String(b.code || '').trim().toUpperCase();
    for (const plan of ['29', '59', '99']) {
      const expected = String(process.env['CODE_' + plan] || DEFAULT_CODES[plan]).trim().toUpperCase();
      if (code && same(code, expected)) return res.status(200).json({ plan });
    }
    return res.status(400).json({ error: 'Wrong code. Please check the code on your payment thank-you page.' });
  }

  // ---- AI generation ----
  const keys = parseKeys();
  if (!keys.length) return res.status(500).json({ error: 'Server is not set up yet (missing AI_API_KEYS).' });
  if (limited('g' + ip, 30, 10 * 60e3)) return res.status(429).json({ error: 'Too many requests. Please wait a few minutes.' });

  const prompt = typeof b.prompt === 'string' ? b.prompt : '';
  if (!prompt || prompt.length > 24000) return res.status(400).json({ error: 'Invalid request or text too long.' });
  const maxTokens = b.long ? 5000 : 2500;

  shuffle(keys); // spread load evenly across all keys
  const deadline = Date.now() + 55000;
  const MAX_ATTEMPTS = Math.min(14, keys.length * 3);
  const dead = new Set();

  for (let a = 0; a < MAX_ATTEMPTS && Date.now() < deadline - 2000; a++) {
    const kobj = keys[a % keys.length];
    if (dead.has(kobj.k)) continue;
    // first 6 attempts use the best model, next 4 the second best, the rest the third
    const tier = a < 6 ? 0 : a < 10 ? 1 : 2;
    try {
      const list = await modelsFor(kobj.p, kobj.k);
      const model = list[Math.min(tier, list.length - 1)];
      const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + kobj.k };
      if (kobj.p === 'or') { headers['X-Title'] = 'ExamPod AI'; headers['HTTP-Referer'] = process.env.SITE_URL || 'https://vercel.app'; }
      const r = await fetch(URLS[kobj.p] + '/chat/completions', {
        method: 'POST', headers,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.6, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(Math.min(30000, deadline - Date.now()))
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) {
        if (r.status === 401 || r.status === 403) dead.add(kobj.k);
        console.error(`key ${kobj.id} (${kobj.p}) ${model} -> ${r.status}`, String(d.error?.message || '').slice(0, 120));
        continue; // silently try the next key
      }
      const text = String(d.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (text) return res.status(200).json({ text });
    } catch (e) {
      console.error(`key ${kobj.id} failed:`, e.name);
    }
  }
  return res.status(503).json({ error: 'Our AI servers are very busy right now. Please try again in 30 seconds.' });
}

module.exports = handler;
module.exports.config = { maxDuration: 60 };
