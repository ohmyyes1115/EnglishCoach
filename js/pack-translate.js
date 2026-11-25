// Layer 2: Whole-Pack Chinese Translation
// Quality first: only the strongest text models the user's own API keys can reach are offered, the lesson is
// translated in order with its surrounding sentences as context, every reply is checked sentence by sentence,
// and a failing model stops the run instead of silently falling back to a weaker one.
// The key-less machine translation used elsewhere as a stand-in is deliberately not available here.

import {
  state,
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

export function rankOpenAiTextModels(ids) {
  const versionOf = (id, suffix) => {
    if (id === `gpt-4o${suffix}`) return 4.05;
    const m = new RegExp(`^gpt-(\\d+(?:\\.\\d+)?)${suffix}$`).exec(id);
    return m ? parseFloat(m[1]) : 0;
  };
  const pick = (suffix, minVersion) => ids
    .map((id) => ({ id, v: versionOf(id, suffix) }))
    .filter((x) => x.v >= minVersion)
    .sort((a, b) => b.v - a.v)
    .map((x) => x.id);
  // Plain "gpt-<version>" ids only: dated snapshots, audio / realtime / image / search / codex variants never match
  return { flagship: pick('', 4.05), mini: pick('-mini', 4.05) };
}

export function rankGeminiTextModels(modelList, family) {
  const excluded = /image|tts|audio|live|embedding|aqa|robotics|computer-use|learnlm|gemma|dialog|lite|vision|customtools/i;
  const ids = [];
  for (const m of modelList || []) {
    const id = String(m?.name || '').replace(/^models\//, '');
    if (!/^gemini-/.test(id) || excluded.test(id)) continue;
    if (!new RegExp(`(^|-)${family}(-|$)`, 'i').test(id)) continue;
    const methods = m?.supportedGenerationMethods;
    if (Array.isArray(methods) && !methods.includes('generateContent')) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  const score = (id) => ({
    version: /-latest$/.test(id) ? 999 : (parseFloat((id.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1]) || 0),
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
// engines: [{ id, provider, providerLabel, model, tier, tierLabel }] best first.
// problems: human-readable reasons why a configured key produced no engine.
export async function listPackTranslationEngines() {
  const cfg = state.aiConfig || {};
  const openaiKey = String(cfg.openaiKey || '').trim();
  const geminiKey = String(cfg.geminiKey || '').trim();
  const groqKey = String(cfg.groqKey || '').trim();
  const engines = [];
  const problems = [];
  const add = (provider, providerLabel, model, tier) => {
    if (!model) return;
    engines.push({ id: `${provider}:${model}`, provider, providerLabel, model, tier, tierLabel: TIER_LABELS[tier] });
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
  return String(en || '').replace(/^\d+[\.\)、\-\s]+/, '').trim();
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
async function callChatCompletions(endpoint, apiKey, model, systemText, userText) {
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

async function callGemini(apiKey, model, systemText, userText) {
  const parts = [{ text: `${systemText}\n\n${userText}` }];
  let maxOutputTokens = 32768;
  let responseMimeType = 'application/json';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await requestGeminiGenerateContent(model, apiKey, parts, 0.3, maxOutputTokens, {
        keepDefaultThinking: true,
        responseMimeType
      });
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

async function callEngine(engine, systemText, userText) {
  const cfg = state.aiConfig || {};
  if (engine.provider === 'openai') {
    return callChatCompletions('https://api.openai.com/v1/chat/completions', String(cfg.openaiKey || '').trim(), engine.model, systemText, userText);
  }
  if (engine.provider === 'groq') {
    return callChatCompletions('https://api.groq.com/openai/v1/chat/completions', String(cfg.groqKey || '').trim(), engine.model, systemText, userText);
  }
  return callGemini(String(cfg.geminiKey || '').trim(), engine.model, systemText, userText);
}

// A key whose plan has no allowance for this model at all (or no credit left): waiting will not help.
// Gemini words its ordinary per-minute limit almost the same way, so there only "limit: 0" counts.
function isZeroQuotaError(err, engine) {
  const msg = String(err?.message || '');
  if (engine?.provider === 'gemini') return /limit:\s*0\b/i.test(msg);
  return /insufficient_quota|exceeded your current quota/i.test(msg);
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
// THE RUN
// ==========================================
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// hooks.onProgress({ done, total, note })   hooks.shouldCancel() -> boolean   hooks.onBatchApplied()
// hooks.callEngine is for tests only.
// Resolves { total, translated, failedIds, cancelled, saveFailed, error } and never rejects:
// whatever was translated before a failure is already applied and saved.
export async function translatePack(pack, engine, scope, hooks = {}) {
  const onProgress = hooks.onProgress || (() => {});
  const shouldCancel = hooks.shouldCancel || (() => false);
  const onBatchApplied = hooks.onBatchApplied || (() => {});
  const send = hooks.callEngine || callEngine;
  const waitFn = hooks.wait || wait;

  const all = (pack?.items || []).map((item, idx) => ({ item, id: idx + 1, en: cleanSentenceText(item.en) }));
  const targets = all.filter((row) => row.en && (scope === 'all' || !(row.item.zh && row.item.zh.trim())));
  const result = { total: targets.length, translated: 0, failedIds: [], cancelled: false, saveFailed: false, error: null };
  const zhSource = `${PACK_TRANSLATE_ZH_SOURCE_PREFIX}${engine.model}`;

  const requestRows = async (rows, contextRows, label) => {
    const userText = buildUserPrompt(pack.name, contextRows, rows);
    for (let retry = 0; ; retry++) {
      try {
        return await send(engine, SYSTEM_PROMPT, userText);
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
