// Layer 2: Whole-Pack Chinese Translation
// Quality first: only the strongest text models the user's own API keys can reach are offered, the lesson is
// translated in order with its surrounding sentences as context, every reply is checked sentence by sentence,
// and a failing model stops the run instead of silently falling back to a weaker one.
// The key-less machine translation used elsewhere as a stand-in is deliberately not available here.

import {
  state,
  safeStorage,
  stripLineNumber,
  savePackToDB,
  PACK_TRANSLATE_ZH_SOURCE_PREFIX
} from './state-storage.js';

import {
  requestGeminiGenerateContent,
  fetchGroqAvailableModelIds,
  rankGroqChatModels
} from './ai-lookup.js';

const BATCH_SIZE = 30;
const CONTEXT_SENTENCES = 4;
const MAX_RATE_LIMIT_RETRIES = 2;

const TIER_LABELS = {
  1: '最高品質',
  2: '品質好、速度快',
  3: '開源模型，中文較弱'
};

// ==========================================
// MODEL DISCOVERY & RANKING
// ==========================================
// Model ids change every few months, so nothing is hardcoded: each provider is asked which models this
// key can use, and the newest general-purpose text model of each family is picked from that answer.

// OpenAI ids come in two shapes: "gpt-<version>" / "gpt-<version>-mini" (through the GPT-5 line) and
// "gpt-<version>-<codename>" (GPT-6 line: "astra" is the frontier model, "sol" the efficient everyday one).
// The model list says nothing about quality, so the codenames are ranked here by hand; an id with any other
// suffix (dated snapshots, pro / nano / codex / audio / realtime / image variants, a codename not known yet)
// is left out rather than guessed at.
const OPENAI_FLAGSHIP_SUFFIXES = ['', '-astra'];
const OPENAI_SECOND_SUFFIXES = ['-mini', '-sol'];

export function rankOpenAiTextModels(ids) {
  const parse = (id) => {
    const m = /^gpt-(\d+(?:\.\d+)?|4o)(-[a-z]+)?$/.exec(id);
    if (!m) return null;
    return { version: m[1] === '4o' ? 4.05 : parseFloat(m[1]), suffix: m[2] || '' };
  };
  const pick = (suffixes) => ids
    .map((id) => ({ id, parsed: parse(id) }))
    .filter((x) => x.parsed && x.parsed.version >= 4.05 && suffixes.includes(x.parsed.suffix))
    .sort((a, b) => b.parsed.version - a.parsed.version)
    .map((x) => x.id);
  return { flagship: pick(OPENAI_FLAGSHIP_SUFFIXES), mini: pick(OPENAI_SECOND_SUFFIXES) };
}

// Gemini 4 dropped the Pro / Flash names for codenames. Google's model page calls Carbon "our strongest
// reasoning model" and Hydrogen the everyday, efficient one (the only Gemini 4 model with a free tier), so
// those two stand in for the old families. Neon and Argon are not ranked against Carbon there and are left out.
const GEMINI_FAMILY_NAMES = { pro: 'pro|carbon', flash: 'flash|hydrogen' };

export function rankGeminiTextModels(modelList, family) {
  const excluded = /image|tts|audio|live|embedding|aqa|robotics|computer-use|learnlm|gemma|dialog|lite|vision|customtools/i;
  const ids = [];
  for (const m of modelList || []) {
    const id = String(m?.name || '').replace(/^models\//, '');
    if (!/^gemini-/.test(id) || excluded.test(id)) continue;
    if (!new RegExp(`(^|-)(${GEMINI_FAMILY_NAMES[family] || family})(-|$)`, 'i').test(id)) continue;
    const methods = m?.supportedGenerationMethods;
    if (Array.isArray(methods) && !methods.includes('generateContent')) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  const score = (id) => ({
    // An alias such as "gemini-pro-latest" does not say which model answers, so it only serves as a last resort
    version: parseFloat((id.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1]) || 0,
    stable: /preview|exp/i.test(id) ? 0 : 1
  });
  // Newest generation first (a newer preview usually translates better than an older stable model),
  // then stable before preview, then the plain id before dated variants
  return ids.sort((a, b) => {
    const x = score(a);
    const y = score(b);
    return (y.version - x.version) || (y.stable - x.stable) || (a.length - b.length);
  });
}

async function fetchJsonWithKey(url, bearerKey) {
  const res = await fetch(url, bearerKey ? { headers: { Authorization: `Bearer ${bearerKey}` } } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Returns { engines, problems }.
// engines: [{ id, provider, providerLabel, model, tier, tierLabel, priceText }] best first.
// Each provider contributes its strongest few models, so the user can trade quality against cost per run.
// problems: human-readable reasons why a configured key produced no engine.
export async function listPackTranslationEngines() {
  const cfg = state.aiConfig || {};
  const openaiKey = String(cfg.openaiKey || '').trim();
  const geminiKey = String(cfg.geminiKey || '').trim();
  const groqKey = String(cfg.groqKey || '').trim();
  const engines = [];
  const problems = [];
  const add = (provider, providerLabel, model, tier, tierLabel = TIER_LABELS[tier]) => {
    if (!model) return;
    engines.push({ id: `${provider}:${model}`, provider, providerLabel, model, tier, tierLabel, priceText: describeModelPrice(model) });
  };

  const jobs = [];
  if (openaiKey) {
    jobs.push((async () => {
      try {
        const data = await fetchJsonWithKey('https://api.openai.com/v1/models', openaiKey);
        const ids = (data?.data || []).map((m) => String(m?.id || '')).filter(Boolean);
        const ranked = rankOpenAiTextModels(ids);
        add('openai', 'OpenAI', ranked.flagship[0], 1);
        add('openai', 'OpenAI', ranked.mini[0], 2);
        if (!ranked.flagship[0] && !ranked.mini[0]) problems.push('OpenAI：這把金鑰的模型清單裡找不到可用的 GPT 文字模型');
      } catch (e) {
        problems.push(`OpenAI：無法取得模型清單（${e?.status === 401 ? '金鑰無效' : (e?.message || '網路錯誤')}）`);
      }
    })());
  }
  if (geminiKey) {
    jobs.push((async () => {
      try {
        const data = await fetchJsonWithKey(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(geminiKey)}`);
        const pro = rankGeminiTextModels(data?.models, 'pro');
        const flash = rankGeminiTextModels(data?.models, 'flash');
        add('gemini', 'Google Gemini', pro[0], 1);
        // The other two Gemini 4 frontier models, labelled the way Google's model page describes them.
        // That page does not rank them against Carbon, so they are offered after it, never ahead of it.
        add('gemini', 'Google Gemini', rankGeminiTextModels(data?.models, 'neon')[0], 1, '前沿等級、速度快');
        add('gemini', 'Google Gemini', rankGeminiTextModels(data?.models, 'argon')[0], 1, '前沿推理、較省 token');
        add('gemini', 'Google Gemini', flash[0], 2);
        if (!pro[0] && !flash[0]) problems.push('Gemini：這把金鑰的模型清單裡找不到可用的文字模型');
      } catch (e) {
        problems.push(`Gemini：無法取得模型清單（${e?.message || '網路錯誤'}）`);
      }
    })());
  }
  if (groqKey) {
    jobs.push((async () => {
      const ids = await fetchGroqAvailableModelIds(groqKey).catch(() => []);
      const ranked = rankGroqChatModels(Array.isArray(ids) ? ids : []);
      if (ranked[0]) add('groq', 'Groq', ranked[0], 3);
      else problems.push('Groq：無法取得此金鑰可用的模型清單');
    })());
  }
  await Promise.all(jobs);

  // Best tier first; inside a tier the provider the user picked in AI settings goes first, then OpenAI, Gemini, Groq
  const providerOrder = ['openai', 'gemini', 'groq'];
  const rank = (e) => (e.provider === cfg.provider ? -1 : providerOrder.indexOf(e.provider));
  engines.sort((a, b) => (a.tier - b.tier) || (rank(a) - rank(b)));
  return { engines, problems };
}

// ==========================================
// REMEMBERED ENGINE CHOICE
// ==========================================
// The exact model is remembered, together with its provider + tier: model ids change every few months, and
// when the remembered one is gone the user's intent ("OpenAI's best", "Gemini's fast one") still picks its successor.
const PREFERRED_ENGINE_LS_KEY = 'car_shadowing_pack_translate_engine_v1';

export function rememberPreferredEngine(engine) {
  if (!engine) return;
  safeStorage.setItem(PREFERRED_ENGINE_LS_KEY, JSON.stringify({ provider: engine.provider, tier: engine.tier, model: engine.model }));
}

export function findPreferredEngine(engines) {
  try {
    const pref = JSON.parse(safeStorage.getItem(PREFERRED_ENGINE_LS_KEY) || 'null');
    if (!pref) return null;
    const list = engines || [];
    return list.find((e) => e.provider === pref.provider && e.model === pref.model)
      || list.find((e) => e.provider === pref.provider && e.tier === pref.tier)
      || null;
  } catch (e) {
    return null;
  }
}

// The engine a run nobody is choosing for (translation right after transcription) may use:
// the one the user picked last time, otherwise the best one on the list. A tier-3 model is never
// picked on the user's behalf; it only runs when the user chose it themself.
export function pickAutoTranslationEngine(engines) {
  return findPreferredEngine(engines) || (engines || []).find((e) => e.tier <= 2) || null;
}

// ==========================================
// PROMPT
// ==========================================
const SYSTEM_PROMPT = [
  '你是專業的英文→台灣繁體中文譯者，正在為英語學習者的「跟讀教材」翻譯字幕。學習者會一邊聽英文、一邊看你的中文來理解句意。',
  '',
  '翻譯要求：',
  '1. 忠實：完整傳達原句的意思、語氣與禮貌程度，不增刪內容，不加解釋、註解或括號補充。',
  '2. 自然：用台灣人日常會說、會寫的中文，避免逐字硬翻與翻譯腔；慣用語、片語動詞要翻出實際意思（例如 "touch base" 是「聯繫一下」，不是「碰基地」）。',
  '3. 用詞：一律使用台灣繁體中文與台灣慣用詞（例如 軟體、資料庫、伺服器、專案、影片、網路、品質、資訊），不可出現簡體字或中國大陸用語。',
  '4. 一致：同一份教材裡，同一個專有名詞、術語、人名的譯法前後一致；通用的英文產品名、縮寫與技術名詞（如 API、Wi-Fi、iPhone）保留原文。',
  '5. 對應：一句英文對應一句中文，不合併、不拆分、不省略；句子不完整或只有幾個字也照樣翻譯。',
  '6. 上下文：這些句子通常是連貫的對話或同一主題的內容，請依前後文決定代名詞、時態、語氣與多義詞的意思。',
  '',
  '輸出格式：只輸出一個 JSON 物件，不要有其他文字或 Markdown：',
  '{"translations":[{"i":<句子編號>,"zh":"<中文翻譯>"}]}',
  '每一句「待翻譯句子」都必須有一筆，編號照抄；「前文」只供理解，不要輸出。'
].join('\n');

export function cleanSentenceText(en) {
  return stripLineNumber(en);
}

export function buildUserPrompt(packName, contextRows, targetRows) {
  const lines = [`教材名稱：${packName || '（未命名）'}`, ''];
  if (contextRows.length > 0) {
    lines.push('前文（只供理解上下文，不要輸出）：');
    contextRows.forEach((r) => lines.push(`- ${r.en}${r.zh ? `　→　${r.zh}` : ''}`));
    lines.push('');
  }
  lines.push('待翻譯句子：');
  targetRows.forEach((r) => lines.push(`[${r.id}] ${r.en}`));
  return lines.join('\n');
}

// ==========================================
// REPLY PARSING & VALIDATION
// ==========================================
const CJK_RE = /[㐀-鿿]/;

function extractJsonValue(rawText) {
  const text = String(rawText || '').replace(/```(?:json)?/gi, '').trim();
  const tryParse = (s) => {
    try { return JSON.parse(s); } catch (e) { return undefined; }
  };
  let value = tryParse(text);
  if (value !== undefined) return value;
  const pairs = [['{', '}'], ['[', ']']];
  for (const [open, close] of pairs) {
    const a = text.indexOf(open);
    const b = text.lastIndexOf(close);
    if (a >= 0 && b > a) {
      value = tryParse(text.slice(a, b + 1));
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

// Returns Map(id -> zh) holding only the entries that pass validation.
// expected: Map(id -> English sentence)
export function parseTranslationReply(rawText, expected) {
  const out = new Map();
  const accept = (rawId, rawZh) => {
    const id = Number(rawId);
    if (!expected.has(id) || out.has(id) || typeof rawZh !== 'string') return;
    const zh = rawZh.replace(/\s*\n+\s*/g, ' ').trim();
    if (!zh) return;
    const en = expected.get(id);
    // A real translation contains Chinese characters; the only exception is a one- or two-word line such as "OK."
    const tinySource = en.split(/\s+/).filter(Boolean).length <= 2;
    if (!CJK_RE.test(zh) && !tinySource) return;
    // The model echoing the English back is not a translation
    if (zh.toLowerCase() === en.toLowerCase() && !tinySource) return;
    out.set(id, zh);
  };

  const value = extractJsonValue(rawText);
  const list = Array.isArray(value)
    ? value
    : (Array.isArray(value?.translations) ? value.translations : null);
  if (list) {
    list.forEach((row) => {
      if (row && typeof row === 'object') {
        accept(row.i ?? row.id ?? row.index ?? row.n, row.zh ?? row.translation ?? row.text);
      }
    });
  } else if (value && typeof value === 'object') {
    // {"12": "中文", ...}
    Object.entries(value).forEach(([k, v]) => accept(k, v));
  } else {
    // Last resort: "[12] 中文" lines
    String(rawText || '').split('\n').forEach((line) => {
      const m = /^\s*\[?(\d+)\]?[\s.:：、-]+(.+)$/.exec(line);
      if (m) accept(m[1], m[2]);
    });
  }
  return out;
}

// ==========================================
// PROVIDER CALLS
// ==========================================
function makeApiError(message, status, retryAfterSec) {
  const err = new Error(message);
  err.status = status || 0;
  if (Number.isFinite(retryAfterSec)) err.retryAfterSec = retryAfterSec;
  return err;
}

// OpenAI and Groq share the chat-completions shape. Newer models refuse some classic parameters
// (a fixed temperature, max_tokens), so a parameter the API names in a 400 reply is dropped and the call repeated.
async function callChatCompletions(endpoint, apiKey, model, systemText, userText, addUsage) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemText },
      { role: 'user', content: userText }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.3,
    max_completion_tokens: 16000
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      // completion_tokens already includes the reasoning tokens
      addUsage(data?.usage ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens } : null);
      const choice = data?.choices?.[0];
      if (choice?.finish_reason === 'length') throw makeApiError(`${model} 回覆被截斷（輸出長度達上限）`, 0);
      return String(choice?.message?.content || '');
    }
    const msg = String(data?.error?.message || `HTTP ${res.status}`);
    if (res.status === 400) {
      const refused = ['temperature', 'response_format', 'max_completion_tokens'].find((p) => p in body && msg.includes(p));
      if (refused) {
        delete body[refused];
        if (refused === 'max_completion_tokens') body.max_tokens = 8000;
        continue;
      }
    }
    const retryAfter = parseFloat(res.headers?.get?.('retry-after') || '');
    throw makeApiError(msg, res.status, retryAfter);
  }
  throw makeApiError(`${model} 不接受這個請求的參數`, 400);
}

async function callGemini(apiKey, model, systemText, userText, addUsage) {
  const parts = [{ text: `${systemText}\n\n${userText}` }];
  let maxOutputTokens = 32768;
  let responseMimeType = 'application/json';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await requestGeminiGenerateContent(model, apiKey, parts, 0.3, maxOutputTokens, {
        keepDefaultThinking: true,
        responseMimeType
      });
      addUsage(out.usage);
      if (out.truncated) throw makeApiError(`${model} 回覆被截斷（輸出長度達上限）`, 0);
      if (!out.text) throw makeApiError(`${model} 回覆內容為空${out.finishReason ? `（${out.finishReason}）` : ''}`, 0);
      return out.text;
    } catch (err) {
      const msg = String(err?.message || '');
      if (maxOutputTokens > 8192 && /max.?output.?tokens/i.test(msg)) {
        maxOutputTokens = 8192;
        continue;
      }
      if (responseMimeType && /response.?mime/i.test(msg)) {
        responseMimeType = '';
        continue;
      }
      if (err.status === undefined || err.status === 0) {
        const isRateLimit = /quota|rate.?limit|resource.?exhausted|too many requests/i.test(msg);
        if (isRateLimit) {
          const m = /retry in ([\d.]+)\s*s/i.exec(msg);
          throw makeApiError(msg, 429, m ? parseFloat(m[1]) : NaN);
        }
      }
      throw err;
    }
  }
  throw makeApiError(`${model} 不接受這個請求的參數`, 400);
}

// addUsage({ inputTokens, outputTokens } | null) is called once for every reply that was actually generated,
// including one that is then rejected as cut off: it was billed all the same.
async function callEngine(engine, systemText, userText, addUsage) {
  const cfg = state.aiConfig || {};
  if (engine.provider === 'openai') {
    return callChatCompletions('https://api.openai.com/v1/chat/completions', String(cfg.openaiKey || '').trim(), engine.model, systemText, userText, addUsage);
  }
  if (engine.provider === 'groq') {
    return callChatCompletions('https://api.groq.com/openai/v1/chat/completions', String(cfg.groqKey || '').trim(), engine.model, systemText, userText, addUsage);
  }
  return callGemini(String(cfg.geminiKey || '').trim(), engine.model, systemText, userText, addUsage);
}

// A key whose plan has no allowance for this model at all (or no credit left): waiting will not help.
// Gemini words its ordinary per-minute limit almost the same way, so there only "limit: 0" counts.
function isZeroQuotaError(err, engine) {
  const msg = String(err?.message || '');
  if (engine?.provider === 'gemini') return /limit:\s*0\b/i.test(msg);
  return /insufficient_quota|exceeded your current quota/i.test(msg);
}

// True when this key cannot use this model at all, so retrying the same model later is pointless
export function isEngineUnavailableError(err, engine) {
  return err?.status === 404 || (err?.status === 429 && isZeroQuotaError(err, engine));
}

export function describeTranslateError(err, engine) {
  const msg = String(err?.message || '未知錯誤').slice(0, 220);
  if (err instanceof TypeError) return `連線失敗，請檢查網路後再試（${msg}）`;
  if (err?.status === 401 || /api key not valid|invalid api key|incorrect api key/i.test(msg)) {
    return `${engine.providerLabel} 金鑰無效，請到 AI 設定檢查`;
  }
  if (err?.status === 429 && isZeroQuotaError(err, engine)) {
    return `這把 ${engine.providerLabel} 金鑰的額度不包含 ${engine.model}（或餘額不足）。可以改選清單裡的另一個模型`;
  }
  if (err?.status === 429) return `${engine.model} 的速率或額度已達上限，請稍後再試（${msg}）`;
  if (err?.status === 404) return `${engine.model} 目前無法使用（${msg}）`;
  return `${engine.model} 呼叫失敗：${msg}`;
}

// ==========================================
// USAGE & COST ESTIMATE
// ==========================================
// The token counts come from the provider and are exact. The amount is an estimate: the API never returns a
// price, so it is worked out from this table. US dollars per 1M tokens (input, output), standard pay-as-you-go
// text rates as published on the OpenAI and Google pricing pages on 2026-11-25. A model that is not listed
// gets token counts only. Rows with several entries change price on the given date.
// free: Google offers a free tier for the model, inside which nothing is charged.
const USD_TO_TWD_ESTIMATE = 32.5; // same rough rate as the call-cost display in gpt-live.js
const MODEL_PRICES = {
  'gpt-6.2-astra': [{ in: 8, out: 40 }],
  'gpt-6.2-sol': [{ in: 2, out: 10 }],
  'gpt-6.1-sol': [{ in: 2, out: 10 }],
  'gpt-6-astra': [{ in: 10, out: 50 }],
  'gpt-6-sol': [{ in: 2, out: 10 }],
  'gpt-5.5': [{ in: 5, out: 30 }],
  'gpt-5.4': [{ in: 2.5, out: 15 }],
  'gpt-5.4-mini': [{ in: 0.75, out: 4.5 }],
  'gpt-5.2': [{ in: 1.75, out: 14 }],
  'gpt-5.1': [{ in: 1.25, out: 10 }],
  'gpt-5': [{ in: 1.25, out: 10 }],
  'gpt-5-mini': [{ in: 0.25, out: 2 }],
  'gpt-4.1': [{ in: 2, out: 8 }],
  'gpt-4.1-mini': [{ in: 0.4, out: 1.6 }],
  'gpt-4o': [{ in: 2.5, out: 10 }],
  'gpt-4o-mini': [{ in: 0.15, out: 0.6 }],
  'gemini-4-carbon': [{ in: 2, out: 10 }, { from: '2026-12-01', in: 4, out: 20 }],
  'gemini-4-neon': [{ in: 3, out: 15 }],
  'gemini-4-argon': [{ in: 2, out: 10 }, { from: '2026-12-01', in: 4, out: 20 }],
  'gemini-4-hydrogen': [{ in: 1.5, out: 7.5, free: true }],
  'gemini-3.8-flash': [{ in: 0.75, out: 3.75, free: true }, { from: '2027-01-01', in: 1.5, out: 7.5, free: true }],
  'gemini-3.6-flash': [{ in: 0.75, out: 3.75, free: true }, { from: '2027-01-01', in: 1.5, out: 7.5, free: true }],
  'gemini-3.1-pro-preview': [{ in: 2, out: 12 }],
  'gemini-3-flash-preview': [{ in: 0.5, out: 3, free: true }]
};

function priceFor(model, now) {
  const rows = MODEL_PRICES[model];
  if (!rows) return null;
  const today = now.toISOString().slice(0, 10);
  let current = rows[0];
  rows.forEach((row) => { if (row.from && row.from <= today) current = row; });
  return current;
}

// Shown beside each model in the list; '' when the model has no price on file
export function describeModelPrice(model, now = new Date()) {
  const price = priceFor(model, now);
  if (!price) return '';
  return `每百萬 token：輸入 $${price.in}／輸出 $${price.out}${price.free ? '｜有免費額度' : ''}`;
}

const hasReportedUsage = (usage) => Boolean(usage) && usage.requests > usage.unreportedRequests;

// Returns { usd, twd, free } or null when the model has no price on file or nothing was reported
export function estimateCost(model, usage, now = new Date()) {
  const price = priceFor(model, now);
  if (!price || !hasReportedUsage(usage)) return null;
  const usd = (usage.inputTokens * price.in + usage.outputTokens * price.out) / 1e6;
  return { usd, twd: usd * USD_TO_TWD_ESTIMATE, free: Boolean(price.free) };
}

const formatUsd = (usd) => `US$${usd.toFixed(usd >= 1 ? 2 : usd >= 0.01 ? 3 : 4)}`;
const formatTwd = (twd) => `NT$${twd.toFixed(twd >= 10 ? 0 : twd >= 0.1 ? 1 : 2)}`;

// One line for the result display; '' when the provider reported nothing at all
export function describeUsage(engine, usage, now = new Date()) {
  if (!hasReportedUsage(usage)) return '';
  const count = (n) => Math.round(n).toLocaleString('en-US');
  let text = `用量：輸入 ${count(usage.inputTokens)}、輸出 ${count(usage.outputTokens)} token（輸出含模型思考）`;
  const cost = estimateCost(engine.model, usage, now);
  text += cost
    ? `｜依公開定價估算約 ${formatUsd(cost.usd)}（約 ${formatTwd(cost.twd)}）${cost.free ? '；若用的是 Gemini 免費額度則不扣款' : ''}`
    : '｜沒有這個模型的單價資料，無法估算金額';
  if (usage.unreportedRequests > 0) text += `｜另有 ${usage.unreportedRequests} 次請求沒有回報用量，實際會再多一些`;
  return text;
}

// ==========================================
// THE RUN
// ==========================================
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// hooks.onProgress({ done, total, note })   hooks.shouldCancel() -> boolean   hooks.onBatchApplied()
// hooks.callEngine is for tests only.
// Resolves { total, translated, failedIds, cancelled, saveFailed, error, usage } and never rejects:
// whatever was translated before a failure is already applied and saved.
export async function translatePack(pack, engine, scope, hooks = {}) {
  const onProgress = hooks.onProgress || (() => {});
  const shouldCancel = hooks.shouldCancel || (() => false);
  const onBatchApplied = hooks.onBatchApplied || (() => {});
  const send = hooks.callEngine || callEngine;
  const waitFn = hooks.wait || wait;

  const all = (pack?.items || []).map((item, idx) => ({ item, id: idx + 1, en: cleanSentenceText(item.en) }));
  const targets = all.filter((row) => row.en && (scope === 'all' || !(row.item.zh && row.item.zh.trim())));
  const result = {
    total: targets.length, translated: 0, failedIds: [], cancelled: false, saveFailed: false, error: null,
    // Tokens the provider reported for this run; unreportedRequests counts replies that came without figures
    usage: { inputTokens: 0, outputTokens: 0, requests: 0, unreportedRequests: 0 }
  };
  const addUsage = (u) => {
    result.usage.requests += 1;
    if (u && Number.isFinite(u.inputTokens) && Number.isFinite(u.outputTokens)) {
      result.usage.inputTokens += u.inputTokens;
      result.usage.outputTokens += u.outputTokens;
    } else {
      result.usage.unreportedRequests += 1;
    }
  };
  const zhSource = `${PACK_TRANSLATE_ZH_SOURCE_PREFIX}${engine.model}`;

  const requestRows = async (rows, contextRows, label) => {
    const userText = buildUserPrompt(pack.name, contextRows, rows);
    for (let retry = 0; ; retry++) {
      try {
        return await send(engine, SYSTEM_PROMPT, userText, addUsage);
      } catch (err) {
        const canWait = err?.status === 429 && !isZeroQuotaError(err, engine) && retry < MAX_RATE_LIMIT_RETRIES;
        if (!canWait) throw err;
        const sec = Math.min(60, Math.max(5, Math.ceil(Number.isFinite(err.retryAfterSec) ? err.retryAfterSec : 20)));
        for (let left = sec; left > 0; left--) {
          if (shouldCancel()) throw err;
          onProgress({ done: result.translated, total: result.total, note: `${label}：遇到速率限制，${left} 秒後自動重試…` });
          await waitFn(1000);
        }
      }
    }
  };

  for (let start = 0; start < targets.length; start += BATCH_SIZE) {
    if (shouldCancel()) {
      result.cancelled = true;
      break;
    }
    const rows = targets.slice(start, start + BATCH_SIZE);
    const label = `第 ${rows[0].id}～${rows[rows.length - 1].id} 句`;
    onProgress({ done: result.translated, total: result.total, note: `${label}：翻譯中…` });

    // The sentences just before this batch, with their current Chinese, keep names, terms and tone continuous
    const firstPos = all.indexOf(rows[0]);
    const contextRows = all.slice(Math.max(0, firstPos - CONTEXT_SENTENCES), firstPos)
      .map((r) => ({ en: r.en, zh: String(r.item.zh || '').trim() }));

    const expected = new Map(rows.map((r) => [r.id, r.en]));
    let got;
    try {
      got = parseTranslationReply(await requestRows(rows, contextRows, label), expected);
      // Ask once more for whatever came back missing or invalid, with the full batch as context
      const missing = rows.filter((r) => !got.has(r.id));
      if (missing.length > 0 && !shouldCancel()) {
        onProgress({ done: result.translated, total: result.total, note: `${label}：有 ${missing.length} 句沒有取得合格的翻譯，重新要求中…` });
        const others = rows.filter((r) => got.has(r.id)).slice(-CONTEXT_SENTENCES).map((r) => ({ en: r.en, zh: got.get(r.id) }));
        const again = parseTranslationReply(
          await requestRows(missing, [...contextRows, ...others], label),
          new Map(missing.map((r) => [r.id, r.en]))
        );
        again.forEach((zh, id) => got.set(id, zh));
      }
    } catch (err) {
      // Cancelling during a rate-limit wait surfaces here too; that is a cancel, not a failure
      if (shouldCancel()) result.cancelled = true;
      else result.error = err;
      break;
    }

    rows.forEach((r) => {
      const zh = got.get(r.id);
      if (zh) {
        r.item.zh = zh;
        r.item.zhSource = zhSource;
        result.translated += 1;
      } else {
        result.failedIds.push(r.id);
      }
    });
    // Saved batch by batch, so an interruption later keeps everything translated so far
    if (state.packs.includes(pack)) {
      const saved = await savePackToDB(pack);
      if (!saved) result.saveFailed = true;
    }
    onBatchApplied();
    onProgress({ done: result.translated, total: result.total, note: `${label}：完成` });
  }
  return result;
}

// ==========================================
// TRANSLATION RIGHT AFTER TRANSCRIPTION
// ==========================================
// Translates freshly transcribed lines before they become a pack. Nobody is picking a model here, so:
// the engine is the one the user ran last time, otherwise the best one available (never tier 3 unasked);
// and when this key turns out to have no access to that model at all, the next model of tier 1-2 is
// tried and the switch is reported. Any other failure stops the run, as in the pack translation window.
//
// lines: [{ en, zh }]; zh and zhSource are filled in place.
// hooks.onNote(text)   hooks.shouldCancel() -> boolean   hooks.onLinesUpdated()
// hooks.listEngines / hooks.callEngine / hooks.wait are for tests only.
// Resolves { engine, skipped: [engine], result, noEngineReason } and never rejects.
export async function translateTranscriptLines(lines, packName, hooks = {}) {
  const onNote = hooks.onNote || (() => {});
  const onLinesUpdated = hooks.onLinesUpdated || (() => {});
  const out = { engine: null, skipped: [], result: null, noEngineReason: '' };

  onNote('正在查詢你的金鑰可用的翻譯模型…');
  const { engines, problems } = await (hooks.listEngines || listPackTranslationEngines)().catch((err) => ({
    engines: [],
    problems: [`查詢模型清單失敗：${err?.message || '未知錯誤'}`]
  }));
  const first = pickAutoTranslationEngine(engines);
  if (!first) {
    out.noEngineReason = engines.length > 0
      ? '目前只有 Groq 的開源模型可用，中文品質較弱'
      : (problems.length > 0 ? problems.join('；') : '需要 OpenAI 或 Google Gemini 的 API 金鑰');
    return out;
  }

  // Numbered like a saved pack, so a sentence that itself starts with a number is not mistaken for a line number
  const draft = { name: packName, items: lines.map((line, i) => ({ en: `${i + 1}. ${line.en}`, zh: '' })) };
  const copyBack = () => {
    draft.items.forEach((item, i) => {
      if (!item.zhSource) return;
      // "||" separates English from Chinese in the subtitle box
      lines[i].zh = item.zh.replace(/\s*\|\|\s*/g, ' ');
      lines[i].zhSource = item.zhSource;
    });
    onLinesUpdated();
  };

  const candidates = [first, ...engines.filter((e) => e !== first && e.tier <= 2)];
  for (let i = 0; i < candidates.length; i++) {
    const engine = candidates[i];
    out.engine = engine;
    out.result = await translatePack(draft, engine, 'all', {
      shouldCancel: hooks.shouldCancel,
      callEngine: hooks.callEngine,
      wait: hooks.wait,
      onProgress: ({ done, total, note }) => onNote(`${engine.model} 翻譯中：${done} / ${total} 句｜${note}`),
      onBatchApplied: copyBack
    });
    const unusable = out.result.error && out.result.translated === 0 && isEngineUnavailableError(out.result.error, engine);
    if (!unusable || !candidates[i + 1]) break;
    out.skipped.push(engine);
  }
  return out;
}
