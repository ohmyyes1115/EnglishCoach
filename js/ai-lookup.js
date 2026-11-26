// Layer 2: AI Concise Explanation (on the model chosen for translation, or the key-less fallback),
// Tap-to-Lookup Word Dictionary, TTS Read Aloud, IndexedDB Note Caching & Audio Transcription

import {
  state,
  escapeHtml,
  formatIdx,
  showGiantHud,
  copyTextSynchronously,
  savePackToDB,
  isPackTranslatedZh,
  stripLineNumber
} from './state-storage.js';

import {
  unlockiOSAudioAndSpeechSynchronously,
  buildTranscribeAudioChunks
} from './audio-processor.js';
import { pausePlaybackInPlace } from './player-engine.js';

// ==========================================
// CALLBACK BRIDGE & HEADER BADGE
// ==========================================
let aiCallbacks = {
  onRenderMainStage: () => {},
  onOpenAiSettings: () => {},
  // (systemText, userText) => Promise<{ text, modelUsed }>: asks the model chosen for translation.
  // Lives in pack-translate.js, which imports this module, so it is handed in instead of imported.
  askTextModel: async () => { throw new Error('AI 查詢尚未初始化'); }
};

// Lower-cased word the drawer is currently showing ('' when it shows the whole-sentence analysis)
let drawerWordKey = '';

export function registerAiCallbacks(cbs = {}) {
  if (typeof cbs.onRenderMainStage === 'function') {
    aiCallbacks.onRenderMainStage = cbs.onRenderMainStage;
  }
  if (typeof cbs.onOpenAiSettings === 'function') {
    aiCallbacks.onOpenAiSettings = cbs.onOpenAiSettings;
  }
  if (typeof cbs.askTextModel === 'function') {
    aiCallbacks.askTextModel = cbs.askTextModel;
  }
}

function hasAnyAiKey() {
  const cfg = state.aiConfig || {};
  return Boolean(cfg.geminiKey || cfg.groqKey || cfg.openaiKey);
}

// True when sentence analysis and word lookup go to a keyed model; false when they run on the key-less
// translation + dictionary (no key filled, or the user switched the keys off for lookups).
function isKeyedLookupActive() {
  return hasAnyAiKey() && !state.aiConfig?.lookupKeyless;
}

export function updateAiHeaderBadgeUI() {
  const el = document.getElementById('aiHeaderBadgeText');
  if (!el || !state.aiConfig) return;
  el.textContent = hasAnyAiKey() ? 'AI就緒' : 'AI設定';
}

// ==========================================
// SPEECH SYNTHESIS (WORD & CHINESE EXPLAIN)
// ==========================================
export function speakSingleEnglishWord(word) {
  if (!word) return;
  unlockiOSAudioAndSpeechSynchronously();
  try {
    if ('speechSynthesis' in window && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(word);
      utter.lang = 'en-US';
      utter.rate = 0.9;
      window.speechSynthesis.speak(utter);
    }
  } catch (e) {}
}

export function speakChineseExplanationAloud() {
  unlockiOSAudioAndSpeechSynchronously();
  const item = state.currentPack?.items?.[state.currentIndex];
  const bodyEl = document.getElementById('aiDrawerBody');
  if (!item && !bodyEl) return;

  // Read whatever the drawer is currently showing: the tapped word's note, or the sentence analysis
  const wordNote = drawerWordKey ? item?.wordNotes?.[drawerWordKey] : null;
  const notesToRead = wordNote ? wordNote.notes : item?.aiNotes;
  const grammarToRead = wordNote ? wordNote.grammar : item?.aiGrammarNote;
  const rawText = (item?.zh ? `中文翻譯：${item.zh}。` : '') +
    (notesToRead ? `重點解析：${notesToRead.replace(/[•【】\[\]]/g, ' ')}。` : '') +
    (grammarToRead ? `句型語氣：${grammarToRead}` : '');
  const fallbackText = bodyEl
    ? bodyEl.innerText.replace(/💡 目前使用.*/g, '').replace(/⚠️.*/g, '').replace(/檢查金鑰/g, '').trim()
    : '';
  // An uncached lookup (keyed engine failed) exists only in the drawer, so read the drawer text itself
  const showingUncachedResult = Boolean(drawerWordKey && !wordNote) || (!drawerWordKey && !notesToRead);
  const toSpeak = ((showingUncachedResult ? '' : rawText) || fallbackText || rawText).trim();
  if (!toSpeak) return;

  try {
    if ('speechSynthesis' in window && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(toSpeak);
      utter.lang = 'zh-TW';
      utter.rate = 1.05;
      window.speechSynthesis.speak(utter);
      showGiantHud('🔊', '正在朗讀中文解析', '開車免看螢幕，聽完可按播放繼續跟讀', 'border-emerald-400/90');
    }
  } catch (e) {}
}

// ==========================================
// RENDERING & FORMATTING HELPERS
// ==========================================
export function formatSavedAiNotesHtml(zhText, notesText, grammarText = '', showZeroKeyTip = false) {
  const lines = String(notesText || '').split('\n').map(l => l.trim()).filter(Boolean);
  const listHtml = lines.map(line => {
    const clean = escapeHtml(line.replace(/^[\-\*•]\s*/, ''));
    return `<li class="flex items-start gap-1.5"><span class="text-violet-400 font-bold">•</span><span>${clean}</span></li>`;
  }).join('');
  const tipHtml = showZeroKeyTip
    ? `<div class="text-[11px] text-slate-400 pt-1.5 flex items-center justify-between gap-2 border-t border-slate-800">
         <span>💡 目前使用免金鑰翻譯字典；填入免費 Gemini / Groq Key 可升級深度語境簡答</span>
         <button type="button" data-open-ai-settings="1" class="px-2 py-0.5 rounded bg-violet-500/20 hover:bg-violet-500/30 text-violet-300 font-bold shrink-0">填入免費Key</button>
       </div>`
    : '';
  return `
    ${zhText ? `<div class="p-2.5 rounded-xl bg-slate-900 border border-slate-800"><div class="text-[11px] font-bold text-sky-400 mb-0.5">【整句中譯】（已自動寫入教材庫）：</div><div class="text-sm sm:text-base font-extrabold text-white">${escapeHtml(zhText)}</div></div>` : ''}
    ${listHtml ? `<div class="p-2.5 rounded-xl bg-slate-900/70 border border-slate-800"><div class="text-[11px] font-bold text-amber-300 mb-1">【重點單字 / 片語】：</div><ul class="space-y-1 text-xs sm:text-sm text-slate-200">${listHtml}</ul></div>` : ''}
    ${grammarText ? `<div class="p-2.5 rounded-xl bg-violet-950/30 border border-violet-500/30"><div class="text-[11px] font-bold text-violet-300 mb-0.5">【句型 / 語氣秒懂】：</div><div class="text-xs sm:text-sm text-slate-200">${escapeHtml(grammarText)}</div></div>` : ''}
    ${tipHtml}
  `;
}

function renderAiDrawerBodyHtml(bodyEl, html) {
  if (!bodyEl) return;
  bodyEl.innerHTML = html;
  bodyEl.querySelectorAll('button[data-open-ai-settings="1"]').forEach((openKeyBtn) => {
    openKeyBtn.addEventListener('click', () => {
      aiCallbacks.onOpenAiSettings();
    });
  });
}

// ==========================================
// FREE TRANSLATION, DICTIONARY & AI API CLIENTS
// ==========================================
export async function fetchFreeGoogleTranslateZhTW(englishText) {
  const cleanEn = String(englishText || '').replace(/^\d+[\.\)、\-\s]+/, '').trim();
  if (!cleanEn) return '';
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-TW&dt=t&q=${encodeURIComponent(cleanEn)}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && Array.isArray(data[0])) {
        return data[0].map(seg => seg[0]).join('').trim();
      }
    }
  } catch (e) {}
  try {
    const url2 = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(cleanEn)}&langpair=en|zh-TW`;
    const res2 = await fetch(url2);
    if (res2.ok) {
      const data2 = await res2.json();
      if (data2?.responseData?.translatedText) return data2.responseData.translatedText.trim();
    }
  } catch (e) {}
  return '';
}

export async function fetchFreeDictionaryEntry(word) {
  const w = String(word || '').toLowerCase().trim();
  if (!w) return null;
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`);
    if (!res.ok) return null;
    const arr = await res.json();
    const first = arr?.[0];
    if (!first) return null;
    const phonetic = first.phonetic || (first.phonetics?.find(p => p.text)?.text) || '';
    const meanings = [];
    (first.meanings || []).slice(0, 2).forEach(m => {
      const pos = m.partOfSpeech || '';
      const def = m.definitions?.[0]?.definition || '';
      if (def) meanings.push(`(${pos}) ${def}`);
    });
    return { phonetic, meanings };
  } catch (e) {
    return null;
  }
}

// ==========================================
// GEMINI: MODEL DISCOVERY & generateContent
// ==========================================
// Google retires Gemini model ids regularly (gemini-2.0-flash is already shut down), so with a key we ask
// the API which Flash models this key can use instead of trusting a hardcoded list (same idea as Groq below).
// The static list is only used when that lookup fails.
const GEMINI_STATIC_FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-3-flash-preview'];
// Without a key the request only works inside a host page that injects one; that host expects this model id
const GEMINI_KEYLESS_MODELS = ['gemini-3-flash-preview'];

let cachedGeminiKeyFp = '';
let cachedGeminiModelIds = null;
let cachedGeminiWorkingModel = '';
const geminiModelsRejectingThinkingConfig = new Set();

function rankGeminiFlashModels(modelList) {
  const excluded = /image|tts|audio|live|embedding|aqa|robotics|computer-use|learnlm|gemma|dialog/i;
  const ids = [];
  for (const m of modelList) {
    const id = String(m?.name || '').replace(/^models\//, '');
    if (!/^gemini-/.test(id) || !/flash/i.test(id) || excluded.test(id)) continue;
    const methods = m?.supportedGenerationMethods;
    if (Array.isArray(methods) && !methods.includes('generateContent')) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  const score = (id) => ({
    stable: /preview|exp/i.test(id) ? 0 : 1,
    version: /-latest$/.test(id) ? 999 : (parseFloat((id.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1]) || 0),
    full: /lite/i.test(id) ? 0 : 1
  });
  // Stable before preview, newer before older, full Flash before Flash-Lite, plain id before dated variants
  return ids.sort((a, b) => {
    const x = score(a);
    const y = score(b);
    return (y.stable - x.stable) || (y.version - x.version) || (y.full - x.full) || (a.length - b.length);
  });
}

async function resolveGeminiCandidateModels(cleanKey) {
  if (!cleanKey) return GEMINI_KEYLESS_MODELS;
  const fp = cleanKey.slice(-10);
  if (cachedGeminiKeyFp !== fp) {
    cachedGeminiKeyFp = fp;
    cachedGeminiModelIds = null;
    cachedGeminiWorkingModel = '';
  }
  if (!cachedGeminiModelIds) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(cleanKey)}`);
      if (res.ok) {
        const data = await res.json();
        const ranked = rankGeminiFlashModels(data?.models || []);
        if (ranked.length > 0) cachedGeminiModelIds = ranked;
      }
    } catch (e) {}
  }
  const base = cachedGeminiModelIds ? cachedGeminiModelIds.slice(0, 5) : GEMINI_STATIC_FALLBACK_MODELS;
  const ordered = [];
  for (const m of [cachedGeminiWorkingModel, ...base]) {
    if (m && !ordered.includes(m)) ordered.push(m);
  }
  return ordered;
}

// Thinking tokens count against maxOutputTokens, so an un-capped thinking model can spend the whole
// budget before writing a single character. These short tasks need no reasoning: switch it off (2.5)
// or down to the minimum (3 and later).
function buildGeminiThinkingConfig(modelName) {
  if (geminiModelsRejectingThinkingConfig.has(modelName)) return null;
  if (/^gemini-(1\.|2\.0)/.test(modelName)) return null;
  if (/^gemini-2\.5/.test(modelName)) return { thinkingBudget: 0 };
  return { thinkingLevel: 'minimal' };
}

// options.keepDefaultThinking: leave the model's own reasoning on (whole-pack translation wants the quality;
//   the caller must then allow a generous maxOutputTokens, because reasoning counts against it)
// options.responseMimeType: e.g. 'application/json'
export async function requestGeminiGenerateContent(modelName, cleanKey, parts, temperature, maxOutputTokens, options = {}) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(cleanKey)}`;
  const send = async (thinkingConfig) => {
    const generationConfig = { temperature, maxOutputTokens };
    if (options.responseMimeType) generationConfig.responseMimeType = options.responseMimeType;
    if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }], generationConfig })
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };

  const thinkingConfig = options.keepDefaultThinking ? null : buildGeminiThinkingConfig(modelName);
  let { res, data } = await send(thinkingConfig);
  if (!res.ok && thinkingConfig && res.status === 400 && /think/i.test(data?.error?.message || '')) {
    // This model does not take the thinking setting we guessed; remember that and ask again without it
    geminiModelsRejectingThinkingConfig.add(modelName);
    ({ res, data } = await send(null));
  }
  if (!res.ok) {
    throw new Error(data?.error?.message || `Gemini HTTP ${res.status}`);
  }

  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .filter(p => p && !p.thought && typeof p.text === 'string')
    .map(p => p.text)
    .join('')
    .trim();
  // Thinking tokens are billed as output, so they are counted with it
  const meta = data?.usageMetadata;
  const usage = meta && Number.isFinite(meta.promptTokenCount)
    ? {
      inputTokens: meta.promptTokenCount,
      outputTokens: (Number(meta.candidatesTokenCount) || 0) + (Number(meta.thoughtsTokenCount) || 0)
    }
    : null;
  return {
    text,
    truncated: candidate?.finishReason === 'MAX_TOKENS',
    finishReason: candidate?.finishReason || data?.promptFeedback?.blockReason || '',
    usage
  };
}

// Trying further models is pointless when the key itself is refused or the network is down
function isGeminiErrorFatalForAllModels(err) {
  if (err instanceof TypeError) return true;
  return /api key not valid|api key expired|API_KEY_INVALID/i.test(err?.message || '');
}

export async function callGeminiFlashConciseApi(promptText, apiKey) {
  const cleanKey = String(apiKey || '').trim();
  const models = await resolveGeminiCandidateModels(cleanKey);
  let lastErr = null;
  for (const modelName of models) {
    try {
      // The prompt itself asks for a short answer; this cap is only a safety net against a runaway reply
      const out = await requestGeminiGenerateContent(modelName, cleanKey, [{ text: promptText }], 0.25, 2048);
      if (out.text && !out.truncated) {
        if (cleanKey) cachedGeminiWorkingModel = modelName;
        return { text: out.text, modelUsed: modelName };
      }
      lastErr = new Error(out.truncated
        ? `${modelName} 回覆被截斷（輸出長度達上限）`
        : `${modelName} 回覆內容為空${out.finishReason ? `（${out.finishReason}）` : ''}`);
    } catch (err) {
      lastErr = err;
      if (isGeminiErrorFatalForAllModels(err)) break;
    }
    if (cachedGeminiWorkingModel === modelName) cachedGeminiWorkingModel = '';
  }
  throw lastErr || new Error('Gemini API 呼叫失敗');
}

let cachedGroqKeyFp = '';
let cachedGroqModelIds = null;
let cachedGroqChatModel = '';
let cachedGroqWhisperModel = '';

export async function fetchGroqAvailableModelIds(apiKey) {
  const cleanKey = String(apiKey || '').trim();
  const fp = cleanKey.slice(-10);
  if (cachedGroqModelIds && cachedGroqKeyFp === fp) {
    return cachedGroqModelIds;
  }
  if (cachedGroqKeyFp !== fp) {
    cachedGroqKeyFp = fp;
    cachedGroqModelIds = null;
    cachedGroqChatModel = '';
    cachedGroqWhisperModel = '';
  }
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${cleanKey}` }
    });
    if (!res.ok) return [];
    const data = await res.json();
    const ids = (data?.data || [])
      .filter(m => m && m.id && m.active !== false)
      .map(m => m.id);
    cachedGroqModelIds = ids;
    return ids;
  } catch (e) {
    return [];
  }
}

export function rankGroqChatModels(availableIds) {
  const excluded = /whisper|guard|tts|playai|orpheus|moderation|embed|safeguard|prompt-guard/i;
  const chatIds = availableIds.filter(id => !excluded.test(id));
  const priority = [
    /^llama-3\.3-70b-versatile$/i,
    /llama-4-scout/i,
    /llama-4-maverick/i,
    /^llama-3\.1-8b-instant$/i,
    /llama-3\.3/i,
    /gpt-oss/i,
    /qwen/i,
    /llama/i
  ];
  const ranked = [];
  for (const re of priority) {
    for (const id of chatIds) {
      if (re.test(id) && !ranked.includes(id)) ranked.push(id);
    }
  }
  for (const id of chatIds) {
    if (!ranked.includes(id)) ranked.push(id);
  }
  return ranked;
}

export async function callGroqConciseApi(promptText, apiKey) {
  const cleanKey = String(apiKey || '').trim();
  const fp = cleanKey.slice(-10);

  let candidates = [];
  if (cachedGroqChatModel && cachedGroqKeyFp === fp) {
    candidates.push(cachedGroqChatModel);
  }

  const availableIds = await fetchGroqAvailableModelIds(cleanKey);
  const discovered = rankGroqChatModels(availableIds);
  const fallbacks = [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'meta-llama/llama-4-scout-17b-16e-instruct'
  ];

  for (const m of [...discovered, ...fallbacks]) {
    if (m && !candidates.includes(m)) candidates.push(m);
  }
  candidates = candidates.slice(0, 6);

  let lastErr = null;
  for (const modelName of candidates) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cleanKey}`
      },
      body: JSON.stringify({
        model: modelName,
        temperature: 0.25,
        max_tokens: 700,
        messages: [
          { role: 'system', content: '你是一位專精台灣繁體中文的車用英文口說教練，回答務必極度精簡扼要。' },
          { role: 'user', content: promptText }
        ]
      })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const choice = data?.choices?.[0];
      const text = choice?.message?.content || '';
      // An empty or cut-off reply (e.g. a reasoning model that spent the budget thinking) is a failure:
      // move on to the next model instead of returning half an answer that would then be cached
      if (text && choice?.finish_reason !== 'length') {
        cachedGroqChatModel = modelName;
        return { text, modelUsed: modelName };
      }
      lastErr = new Error(text ? `${modelName} 回覆被截斷（輸出長度達上限）` : `${modelName} 回覆內容為空`);
      if (cachedGroqChatModel === modelName) cachedGroqChatModel = '';
      continue;
    }
    const errMsg = data?.error?.message || `Groq HTTP ${res.status}`;
    lastErr = new Error(errMsg);
    if (res.status === 401) break; // Invalid key, stop immediately
    if (cachedGroqChatModel === modelName) cachedGroqChatModel = '';
  }

  throw lastErr || new Error('Groq 找不到此金鑰可用的對話模型，請檢查 Groq Console 的模型權限設定');
}

const LOOKUP_SYSTEM_TEXT = '你是一位專精台灣繁體中文的車用英文口說教練，回答務必極度精簡扼要。';

// Sentence analysis and word lookup run on the model the user chose for translation.
// Throws without a network request when lookups are key-less; the callers then use the free stand-in.
export async function queryConfiguredAiEngine(promptText) {
  if (!isKeyedLookupActive()) throw new Error('KeylessLookup');
  return await aiCallbacks.askTextModel(LOOKUP_SYSTEM_TEXT, promptText);
}

export function parseAiStructuredResponse(rawText) {
  const text = String(rawText || '').trim();
  let zh = '';
  let grammar = '';
  const notes = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const cleanLine = line.replace(/^\*\*|\*\*$/g, '').trim();
    if (!zh && /^(【?整句中譯】?|中譯|翻譯|中文|整句翻譯)[:：]?/i.test(cleanLine)) {
      const val = cleanLine.replace(/^(【?整句中譯】?|中譯|翻譯|中文|整句翻譯)[:：]?\s*/i, '').trim();
      if (val) zh = val;
    } else if (/^(【?句型.*】?|句型|語氣|文法|用法)[:：]?/i.test(cleanLine)) {
      const val = cleanLine.replace(/^(【?句型[^:：]*】?|句型|語氣|文法|用法)[:：]?\s*/i, '').trim();
      if (val) grammar = val;
    } else if (!/^(【?重點單字.*】?)[:：]?$/i.test(cleanLine)) {
      notes.push(cleanLine.replace(/^[\-\*•]\s*/, ''));
    }
  }
  if (!zh && notes.length > 0) zh = notes.shift();
  return { zh, notes: notes.join('\n'), grammar };
}

export async function persistZhAndNotesToCurrentItem(zhTranslation, notesText, grammarText = '') {
  const item = state.currentPack?.items?.[state.currentIndex];
  if (!item) return;
  let changed = false;
  if (zhTranslation && (!item.zh || !item.zh.trim())) {
    item.zh = zhTranslation.trim();
    changed = true;
  }
  if (notesText) {
    item.aiNotes = notesText.trim();
    changed = true;
  }
  if (grammarText) {
    item.aiGrammarNote = grammarText.trim();
    changed = true;
  }
  if (changed) {
    aiCallbacks.onRenderMainStage();
    await savePackToDB(state.currentPack);
  }
}

// Word lookups are cached per word only. They must never be written into the sentence-level
// aiNotes / aiGrammarNote, otherwise "AI 簡答" would show a single-word note as the cached sentence analysis.
// Pass entry = null to keep only the sentence translation (used when the result is a stand-in we must not cache).
async function saveWordLookupResult(pack, item, wordKey, entry, sentenceZh) {
  if (!pack || !item) return;
  let changed = false;
  if (entry) {
    if (!item.wordNotes) item.wordNotes = {};
    item.wordNotes[wordKey] = entry;
    changed = true;
  }
  if (sentenceZh && !(item.zh && item.zh.trim())) {
    item.zh = sentenceZh.trim();
    aiCallbacks.onRenderMainStage();
    changed = true;
  }
  if (changed && state.packs.includes(pack)) {
    await savePackToDB(pack);
  }
}

// Packs saved before this fix may hold a single-word note in aiNotes; treat that as "not analysed yet"
function isSentenceNotesFromWordLookup(item) {
  const notes = String(item?.aiNotes || '').trim();
  if (!notes || !item.wordNotes) return false;
  return Object.values(item.wordNotes).some(w => w && String(w.notes || '').trim() === notes);
}

// Name to show for a failed lookup: the provider that was asked, or '' when lookups run key-less by choice.
// A failure only counts as an error worth showing when this is non-empty.
function getFailedAiEngineLabel(err) {
  return isKeyedLookupActive() ? (err?.engineLabel || 'AI') : '';
}

// Grammar placeholder stored alongside key-less fallback notes; doubles as the marker for such notes
const FREE_FALLBACK_GRAMMAR_HINT = '可點擊上方英文句子中的任一單字即查音標與字義，或點「🔊 唸出中文解析」用聽的學。';

function hasCachedSentenceAnalysis(item) {
  if (!item?.aiNotes || !item.aiNotes.trim()) return false;
  if (isSentenceNotesFromWordLookup(item)) return false;
  // Key-less fallback notes are only a stand-in: once a keyed engine is configured, analyse for real
  if (isKeyedLookupActive() && item.aiGrammarNote === FREE_FALLBACK_GRAMMAR_HINT) return false;
  return true;
}

function reportAiEngineFailure(engineLabel, err) {
  if (engineLabel && typeof window.logDiag === 'function') {
    window.logDiag('WARN', `${engineLabel} 呼叫失敗：${err?.message || '未知錯誤'}`);
  }
}

function formatAiErrorBannerHtml(engineLabel, err, noteText) {
  const msg = String(err?.message || '未知錯誤').slice(0, 160);
  return `<div class="p-2.5 rounded-xl bg-rose-950/40 border border-rose-500/40 text-[11px] text-rose-200 flex items-center justify-between gap-2">
      <span>⚠️ ${escapeHtml(engineLabel)} 呼叫失敗：${escapeHtml(msg)}｜${escapeHtml(noteText)}</span>
      <button type="button" data-open-ai-settings="1" class="px-2 py-0.5 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 font-bold shrink-0">檢查金鑰</button>
    </div>`;
}

// ==========================================
// TAP-WORD LOOKUP & FULL-SENTENCE EXPLAIN ACTIONS
// ==========================================
export async function handleTapEnglishWordLookup(word, tokenEl) {
  const cleanWord = String(word || '').trim();
  if (!cleanWord) return;
  state.activeLookupWord = cleanWord;
  if (state.isPlaying) pausePlaybackInPlace('點字查詢暫停');

  document.querySelectorAll('#displayEnglish .word-token').forEach(el => {
    el.classList.toggle('word-token-active', el === tokenEl);
  });

  const pack = state.currentPack;
  const item = pack?.items?.[state.currentIndex];
  const fullSentence = item ? String(item.en || '').replace(/^\d+[\.\)、\-\s]+/, '').trim() : '';
  const wordKey = cleanWord.toLowerCase();

  const drawer = document.getElementById('aiExplainDrawer');
  const badge = document.getElementById('aiDrawerBadge');
  const targetLabel = document.getElementById('aiDrawerTargetLabel');
  const speakBtn = document.getElementById('btnSpeakLookupWord');
  const bodyEl = document.getElementById('aiDrawerBody');
  if (!drawer || !badge || !targetLabel || !speakBtn || !bodyEl) return;

  drawer.classList.remove('hidden');
  targetLabel.textContent = `單字：${cleanWord}`;
  speakBtn.classList.remove('hidden');
  speakBtn.onclick = () => speakSingleEnglishWord(cleanWord);

  drawerWordKey = wordKey;

  if (item && item.wordNotes && item.wordNotes[wordKey]) {
    const cached = item.wordNotes[wordKey];
    badge.textContent = '✨ 單字快取 (0ms)';
    renderAiDrawerBodyHtml(bodyEl, formatSavedAiNotesHtml(item.zh || cached.zh, cached.notes, cached.grammar || '', false));
    return;
  }

  badge.textContent = '👆 點字即查';
  bodyEl.innerHTML = `<div class="flex items-center gap-2 text-violet-300 font-bold py-2"><i class="fa-solid fa-spinner animate-spin"></i><span>正在查詢「${escapeHtml(cleanWord)}」在本句中的精準字義...</span></div>`;

  const prompt = `請針對英文句子："${fullSentence}" 裡面的單字 "${cleanWord}" 用台灣繁體中文極簡回答（總字數 90 字內）：\n中譯：(整句話的自然繁體中文翻譯)\n• 【${cleanWord}】音標、詞性、在這句話裡的精準中文意思\n• 常見搭配詞或同義替換 1 條\n句型：(該字在本句中的語氣或用法提示 1 短句)`;
  let aiError = null;
  try {
    const res = await queryConfiguredAiEngine(prompt);
    const parsed = parseAiStructuredResponse(res.text);
    if (!parsed.zh && !parsed.notes) throw new Error('AI 回覆內容為空');
    badge.textContent = `🤖 ${res.modelUsed}`;
    await saveWordLookupResult(
      pack,
      item,
      wordKey,
      { zh: parsed.zh || item?.zh, notes: parsed.notes, grammar: parsed.grammar },
      parsed.zh
    );
    renderAiDrawerBodyHtml(bodyEl, formatSavedAiNotesHtml(parsed.zh || item?.zh, parsed.notes, parsed.grammar, false));
    return;
  } catch (e) {
    aiError = e;
  }

  // A keyed engine failing (bad key, quota, network) is shown to the user and its stand-in result is not cached,
  // so the next lookup retries. Running key-less by choice keeps the original silent, cached behaviour.
  const failedEngine = getFailedAiEngineLabel(aiError);
  reportAiEngineFailure(failedEngine, aiError);

  badge.textContent = failedEngine ? `⚠️ ${failedEngine} 失敗・暫用免金鑰字典` : '⚡ 免金鑰即時字典';
  const [wordZh, sentenceZh, dictInfo] = await Promise.all([
    fetchFreeGoogleTranslateZhTW(cleanWord),
    (item && item.zh) ? Promise.resolve(item.zh) : fetchFreeGoogleTranslateZhTW(fullSentence),
    fetchFreeDictionaryEntry(cleanWord)
  ]);
  const ph = dictInfo?.phonetic ? ` ${dictInfo.phonetic}` : '';
  const defs = dictInfo?.meanings?.length ? `\n• 詞性與釋義：${dictInfo.meanings.join(' / ')}` : '';
  const noteBlock = `【${cleanWord}】${ph}：${wordZh || '請見下方釋義'}${defs}`;
  await saveWordLookupResult(
    pack,
    item,
    wordKey,
    failedEngine ? null : { zh: sentenceZh || item?.zh, notes: noteBlock, grammar: '' },
    sentenceZh
  );
  const hasKey = hasAnyAiKey();
  const errorBanner = failedEngine
    ? formatAiErrorBannerHtml(failedEngine, aiError, '本次暫用免金鑰字典，不會存入快取，下次點擊會重試')
    : '';
  renderAiDrawerBodyHtml(bodyEl, errorBanner + formatSavedAiNotesHtml(sentenceZh || item?.zh, noteBlock, '', !hasKey));
}

export async function actionAiExplainCurrentSentence(forceRefresh = false) {
  const item = state.currentPack?.items?.[state.currentIndex];
  if (!item) return;
  if (state.isPlaying) pausePlaybackInPlace('AI簡答暫停');

  const cleanSentence = String(item.en || '').replace(/^\d+[\.\)、\-\s]+/, '').trim();
  const drawer = document.getElementById('aiExplainDrawer');
  const badge = document.getElementById('aiDrawerBadge');
  const targetLabel = document.getElementById('aiDrawerTargetLabel');
  const speakBtn = document.getElementById('btnSpeakLookupWord');
  const bodyEl = document.getElementById('aiDrawerBody');
  if (!drawer || !badge || !targetLabel || !speakBtn || !bodyEl) return;

  drawer.classList.remove('hidden');
  speakBtn.classList.add('hidden');
  targetLabel.textContent = `第 #${formatIdx(state.currentIndex + 1)} 句整句簡答`;
  drawerWordKey = '';

  if (!forceRefresh && hasCachedSentenceAnalysis(item)) {
    badge.textContent = '✨ 已存快取 (0ms)';
    renderAiDrawerBodyHtml(bodyEl, formatSavedAiNotesHtml(item.zh, item.aiNotes, item.aiGrammarNote || '', false));
    return;
  }

  bodyEl.innerHTML = `<div class="flex items-center gap-2 text-violet-300 font-bold py-2"><i class="fa-solid fa-spinner animate-spin"></i><span>正在翻譯並拆解本句重點單字與句型...</span></div>`;

  const prompt = `請幫我用台灣繁體中文極簡解析這句英文口說："${cleanSentence}"\n請嚴格依照以下格式回覆（總字數 120 字內）：\n中譯：(最自然道地的繁體中文翻譯)\n• (核心單字或片語 1：音標＋中文意思)\n• (核心單字或片語 2：音標＋中文意思)\n• (核心單字或片語 3：音標＋中文意思)\n句型：(1句話秒懂這句的文法結構與語氣用法)`;
  let aiError = null;
  try {
    const res = await queryConfiguredAiEngine(prompt);
    const parsed = parseAiStructuredResponse(res.text);
    if (!parsed.zh && !parsed.notes) throw new Error('AI 回覆內容為空');
    badge.textContent = `🤖 ${res.modelUsed}`;
    // A whole-pack translation (strongest model, whole lesson as context) outranks this quick one-sentence reply
    const keepPackZh = isPackTranslatedZh(item);
    if (parsed.zh && !keepPackZh) item.zh = parsed.zh;
    // Drop the key-less placeholder so a real analysis without a grammar line is not mistaken for a fallback
    if (item.aiGrammarNote === FREE_FALLBACK_GRAMMAR_HINT) item.aiGrammarNote = '';
    await persistZhAndNotesToCurrentItem(parsed.zh, parsed.notes, parsed.grammar);
    renderAiDrawerBodyHtml(bodyEl, formatSavedAiNotesHtml(keepPackZh ? item.zh : (parsed.zh || item.zh), parsed.notes, parsed.grammar, false));
    return;
  } catch (e) {
    aiError = e;
  }

  // A keyed engine failing (bad key, quota, network) is shown to the user and nothing is cached as "已解析",
  // so the next press retries. Running key-less by choice keeps the original silent, cached behaviour.
  const failedEngine = getFailedAiEngineLabel(aiError);
  reportAiEngineFailure(failedEngine, aiError);

  if (failedEngine && hasCachedSentenceAnalysis(item)) {
    // A refresh failed but an earlier real analysis exists: keep showing it rather than a weaker stand-in
    badge.textContent = `⚠️ ${failedEngine} 失敗・顯示先前解析`;
    renderAiDrawerBodyHtml(
      bodyEl,
      formatAiErrorBannerHtml(failedEngine, aiError, '以下為先前已存的解析') +
        formatSavedAiNotesHtml(item.zh, item.aiNotes, item.aiGrammarNote || '', false)
    );
    return;
  }

  badge.textContent = failedEngine ? `⚠️ ${failedEngine} 失敗・暫用免金鑰翻譯` : '⚡ 免金鑰智慧翻譯';
  // forceRefresh re-fetches the key-less translation, except over a whole-pack translation, which is better than it
  const translatedZh = ((forceRefresh && !failedEngine && !isPackTranslatedZh(item)) ? '' : item.zh) || (await fetchFreeGoogleTranslateZhTW(cleanSentence));
  const words = (cleanSentence.match(/[A-Za-z]{5,}/g) || [])
    .map(w => w.toLowerCase())
    .filter((w, i, arr) => arr.indexOf(w) === i)
    .slice(0, 3);
  const wordNotes = [];
  for (const w of words) {
    const [wZh, dInfo] = await Promise.all([fetchFreeGoogleTranslateZhTW(w), fetchFreeDictionaryEntry(w)]);
    const ph = dInfo?.phonetic ? ` ${dInfo.phonetic}` : '';
    const pos = dInfo?.meanings?.[0] ? ` — ${dInfo.meanings[0]}` : '';
    wordNotes.push(`【${w}】${ph}：${wZh}${pos}`);
  }
  const finalNotes = wordNotes.join('\n') || '點擊上方英文句子中的任一單字，即可單獨查詢發音與字義。';
  if (failedEngine) {
    // Keep only the translation (when the sentence had none); notes stay uncached so "已解析" is not shown
    await persistZhAndNotesToCurrentItem(translatedZh, '', '');
    renderAiDrawerBodyHtml(
      bodyEl,
      formatAiErrorBannerHtml(failedEngine, aiError, '本次暫用免金鑰翻譯，不會標成「已解析」，下次會重試') +
        formatSavedAiNotesHtml(translatedZh || item.zh, finalNotes, '', false)
    );
    return;
  }

  if (translatedZh) item.zh = translatedZh;
  await persistZhAndNotesToCurrentItem(translatedZh, finalNotes, FREE_FALLBACK_GRAMMAR_HINT);
  const hasKey = hasAnyAiKey();
  renderAiDrawerBodyHtml(bodyEl, formatSavedAiNotesHtml(translatedZh || item.zh, finalNotes, item.aiGrammarNote, !hasKey));
}

export function actionCopySentenceWithAiPrompt() {
  const item = state.currentPack?.items?.[state.currentIndex];
  if (!item) return;
  const cleanEn = String(item.en || '').replace(/^\d+[\.\)、\-\s]+/, '').trim();
  const prompt = `請用台灣繁體中文幫我翻譯這句英文，並精簡列出 3 個重點單字/片語與句型結構：\n"${cleanEn}"`;
  copyTextSynchronously(prompt);
  showGiantHud('📋', '已連同提問指令複製', '可直接貼到 ChatGPT / Gemini 詢問', 'border-violet-400/90');
}

// ==========================================
// AI AUDIO TRANSCRIPTION (WHISPER / GEMINI)
// ==========================================
function pickTranscriptionEngine() {
  const cfg = state.aiConfig || {};
  // Groq first whenever its key is filled: its Whisper gives exact timestamps, and OpenAI's only
  // timestamp model (whisper-1) shuts down on 2027-02-26. Then OpenAI (timestamps), then Gemini (none).
  if (cfg.groqKey) return { type: 'groq', key: cfg.groqKey };
  if (cfg.openaiKey) return { type: 'openai', key: cfg.openaiKey };
  if (cfg.geminiKey) return { type: 'gemini', key: cfg.geminiKey };
  return null;
}

const WHISPER_HALLUCINATION_RE = /^(thank you\.?|thanks for watching\.?|thanks\.?|you\.?|bye\.?|subtitles by.*|amara\.org.*)$/i;

async function transcribeChunkViaWhisper(chunk, providerType, apiKey) {
  const isGroq = providerType === 'groq';
  const cleanKey = String(apiKey || '').trim();
  const endpoint = isGroq
    ? 'https://api.groq.com/openai/v1/audio/transcriptions'
    : 'https://api.openai.com/v1/audio/transcriptions';

  // Prioritize full whisper-large-v3 over turbo for much higher accuracy and fewer skipped sentences
  let models = isGroq ? ['whisper-large-v3', 'whisper-large-v3-turbo'] : ['whisper-1'];
  if (isGroq) {
    const fp = cleanKey.slice(-10);
    const ordered = [];
    if (cachedGroqWhisperModel && cachedGroqKeyFp === fp) ordered.push(cachedGroqWhisperModel);
    const availableIds = await fetchGroqAvailableModelIds(cleanKey);
    const whisperIds = availableIds.filter(id => /whisper/i.test(id));
    for (const pref of ['whisper-large-v3', 'whisper-large-v3-turbo']) {
      if (whisperIds.includes(pref) && !ordered.includes(pref)) ordered.push(pref);
    }
    for (const id of whisperIds) {
      if (!ordered.includes(id)) ordered.push(id);
    }
    for (const fb of models) {
      if (!ordered.includes(fb)) ordered.push(fb);
    }
    models = ordered;
  }

  let data = null;
  let modelUsed = models[0];
  let lastErr = null;

  for (const model of models) {
    const form = new FormData();
    form.append('file', chunk.wavBlob, `chunk_${chunk.index}.wav`);
    form.append('model', model);
    form.append('language', 'en');
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cleanKey}`
      },
      body: form
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      data = json;
      modelUsed = model;
      if (isGroq) cachedGroqWhisperModel = model;
      break;
    }
    lastErr = new Error(json?.error?.message || `${isGroq ? 'Groq' : 'OpenAI'} Whisper HTTP ${res.status}`);
    if (res.status === 401) break;
  }

  if (!data) {
    throw lastErr || new Error('Whisper 語音辨識失敗');
  }

  const sizeMb = (chunk.wavBlob.size / (1024 * 1024)).toFixed(2);
  const segCount = Array.isArray(data.segments) ? data.segments.length : 0;
  console.info(`[ASR] model=${modelUsed} chunk=#${chunk.index} (${chunk.startSec.toFixed(2)}s-${chunk.endSec.toFixed(2)}s, ${sizeMb}MB) -> ${segCount} segments`);
  if (typeof window.logDiag === 'function') {
    window.logDiag('INFO', `ASR ${modelUsed} chunk#${chunk.index}: ${segCount} segs (${sizeMb}MB)`);
  }

  const results = [];
  if (Array.isArray(data.segments) && data.segments.length > 0) {
    for (const seg of data.segments) {
      const text = String(seg.text || '').trim();
      if (!text) continue;
      const noSpeech = Number(seg.no_speech_prob) || 0;
      const avgLogprob = Number.isFinite(Number(seg.avg_logprob)) ? Number(seg.avg_logprob) : 0;
      const rawStart = Math.max(0, Number(seg.start) || 0);
      const rawEnd = Math.max(rawStart, Number(seg.end) || 0);
      const segDur = rawEnd - rawStart;

      // Filter silence hallucinations without dropping clear real speech
      if (noSpeech > 0.85 && text.length < 20) continue;
      if (WHISPER_HALLUCINATION_RE.test(text) && (noSpeech > 0.45 || avgLogprob < -0.85 || segDur > 4.5)) {
        console.warn(`[ASR] Filtered likely silence hallucination: "${text}" (no_speech=${noSpeech.toFixed(2)}, dur=${segDur.toFixed(1)}s)`);
        continue;
      }

      results.push({
        en: text,
        zh: '',
        startSec: chunk.startSec + rawStart,
        endSec: chunk.startSec + rawEnd
      });
    }
  } else if (data.text) {
    const sentences = String(data.text)
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(Boolean);
    const span = Math.max(0.5, chunk.endSec - chunk.startSec);
    const step = span / Math.max(1, sentences.length);
    sentences.forEach((en, i) => {
      results.push({
        en,
        zh: '',
        startSec: chunk.startSec + i * step,
        endSec: chunk.startSec + (i + 1) * step
      });
    });
  }
  return { modelUsed, entries: results };
}

async function transcribeChunkViaGemini(chunk, apiKey) {
  const cleanKey = String(apiKey || '').trim();
  const models = await resolveGeminiCandidateModels(cleanKey);
  // English only: listening and translating in one call gave a weaker Chinese line than the dedicated
  // translation pass (pack-translate.js), which runs on the finished transcript afterwards
  const prompt = [
    'Transcribe all spoken English in this audio accurately with proper capitalization and punctuation.',
    'Write exactly what is said: do not paraphrase, summarize, correct grammar, or translate.',
    'Output strictly one natural sentence per line, in English only.',
    'Rules: Do NOT include line numbers, timestamps, speaker labels, markdown bullets, translations, or any extra explanation.'
  ].join('\n');

  const base64Audio = chunk.toBase64();
  let lastErr = null;

  for (const modelName of models) {
    try {
      const out = await requestGeminiGenerateContent(
        modelName,
        cleanKey,
        [
          { text: prompt },
          { inline_data: { mime_type: 'audio/wav', data: base64Audio } }
        ],
        0.1,
        8192
      );
      const reply = out.text;
      if (!reply) {
        lastErr = new Error(`${modelName} 聽打回覆內容為空${out.finishReason ? `（${out.finishReason}）` : ''}`);
        continue;
      }
      // A cut-off transcript is still mostly usable, so keep it, but leave a trace for the diagnostics log
      if (out.truncated && typeof window.logDiag === 'function') {
        window.logDiag('WARN', `Gemini 聽打 chunk#${chunk.index} 輸出達上限，這一段的結尾可能缺漏`);
      }

      const entries = reply
        .split('\n')
        .map(line => stripLineNumber(line.replace(/^[\-\*•\s]+/, '')))
        .filter(Boolean)
        .filter(line => !/^```/.test(line))
        // A model that adds "|| 中文" anyway is tolerated: only the English part is kept
        .map(line => ({ en: (line.split('||')[0] || '').trim(), zh: '' }))
        .filter(item => item.en);

      return { modelUsed: modelName, entries };
    } catch (err) {
      lastErr = err;
      if (isGeminiErrorFatalForAllModels(err)) break;
    }
  }
  throw lastErr || new Error('Gemini 語音聽打失敗');
}

function mergeBrokenSentenceFragments(lines, segments) {
  if (!segments || lines.length !== segments.length || lines.length < 2) {
    return { lines, segments };
  }
  const mergedLines = [];
  const mergedSegments = [];
  for (let i = 0; i < lines.length; i++) {
    const curLine = lines[i];
    const curSeg = segments[i];
    if (mergedLines.length > 0) {
      const prevLine = mergedLines[mergedLines.length - 1];
      const prevSeg = mergedSegments[mergedSegments.length - 1];
      const prevText = prevLine.en.trim();
      const curText = curLine.en.trim();

      const prevEndsSentence = /[.!?]["'”’)\]]*$/.test(prevText);
      const prevEndsComma = /[,;:]["'”’)\]]*$/.test(prevText);
      const curStartsLower = /^[a-z]/.test(curText);
      const gap = curSeg.startSec - prevSeg.endSec;
      const prevDur = prevSeg.endSec - prevSeg.startSec;
      const curDur = curSeg.endSec - curSeg.startSec;
      const combinedDur = curSeg.endSec - prevSeg.startSec;
      const prevWords = prevText.split(/\s+/).filter(Boolean).length;
      const curWords = curText.split(/\s+/).filter(Boolean).length;

      // Only rejoin genuine mid-sentence fragments; never merge two full-length sentences
      const isMidClauseCut =
        !prevEndsSentence &&
        !prevEndsComma &&
        curStartsLower &&
        gap <= 0.5 &&
        combinedDur <= 7.0 &&
        (Math.min(prevDur, curDur) <= 2.6 || Math.min(prevWords, curWords) <= 6);

      // Allow merging a short comma-ending intro phrase (e.g. "At the moment,") only when very brief
      const isShortIntroCommaCut =
        prevEndsComma &&
        curStartsLower &&
        gap <= 0.35 &&
        prevWords <= 5 &&
        prevDur <= 2.0 &&
        combinedDur <= 6.2;

      if (isMidClauseCut || isShortIntroCommaCut) {
        prevLine.en = `${prevText} ${curText}`;
        prevSeg.endSec = curSeg.endSec;
        continue;
      }
    }
    mergedLines.push({ ...curLine });
    mergedSegments.push({ ...curSeg });
  }
  return { lines: mergedLines, segments: mergedSegments };
}

export async function transcribeLongAudioWithAi(audioBuffer, onProgress = () => {}) {
  const engine = pickTranscriptionEngine();
  if (!engine) {
    const err = new Error('請先於「AI設定」填入免費的 Groq 或 Gemini API Key');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const totalDur = Number(audioBuffer?.duration) || 0;
  const isWhisper = engine.type === 'groq' || engine.type === 'openai';
  // Keep Groq chunks strictly <= 80s to avoid Groq server-side ~100s parallel seam stitching bugs
  const maxChunkSec = engine.type === 'groq' ? 80 : (engine.type === 'openai' ? 300 : 180);

  onProgress('⚙️ 正在進行 16kHz 抗混疊重採樣並依句間靜音智慧分段...');
  const { chunks, trimmedHeadSec, resamplerUsed } = await buildTranscribeAudioChunks(audioBuffer, maxChunkSec);
  if (!chunks.length) {
    throw new Error('音檔長度過短或全段為靜音，無法進行語音聽打');
  }

  let allLines = [];
  let allSegments = [];
  let modelUsed = '';

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const label = isWhisper
      ? (engine.type === 'groq' ? 'Groq Whisper' : 'OpenAI Whisper')
      : 'Gemini 聽打';
    const trimNote = trimmedHeadSec > 0.2 ? `｜已裁去開頭 ${trimmedHeadSec.toFixed(1)}s 靜音` : '';
    onProgress(`🎙️ ${label} 辨識中 (${i + 1}/${chunks.length} 段${trimNote})...`);

    if (isWhisper) {
      const res = await transcribeChunkViaWhisper(chunk, engine.type, engine.key);
      modelUsed = res.modelUsed;
      for (const entry of res.entries) {
        const pad = 0.06;
        let startSec = Math.max(0, entry.startSec - pad);
        let endSec = Math.min(totalDur, Math.max(startSec + 0.2, entry.endSec + pad));
        if (allSegments.length > 0) {
          const prev = allSegments[allSegments.length - 1];
          if (startSec < prev.endSec) {
            const mid = (prev.endSec + startSec) / 2;
            prev.endSec = Math.max(prev.startSec + 0.15, mid);
            startSec = prev.endSec;
            endSec = Math.max(startSec + 0.15, endSec);
          }
        }
        allLines.push({ en: entry.en, zh: '' });
        allSegments.push({ startSec, endSec });
      }
    } else {
      const res = await transcribeChunkViaGemini(chunk, engine.key);
      modelUsed = res.modelUsed;
      for (const entry of res.entries) {
        allLines.push({ en: entry.en, zh: entry.zh });
      }
    }
  }

  if (isWhisper && allSegments.length === allLines.length) {
    const cleaned = mergeBrokenSentenceFragments(allLines, allSegments);
    allLines = cleaned.lines;
    allSegments = cleaned.segments;
  }

  if (!allLines.length) {
    throw new Error('未辨識出有效英文語音，請確認音檔音量或更換清晰音訊');
  }

  return {
    mode: isWhisper ? 'whisper' : 'gemini',
    modelUsed,
    lines: allLines,
    segments: isWhisper && allSegments.length === allLines.length ? allSegments : null,
    trimmedHeadSec,
    chunkCount: chunks.length,
    resamplerUsed
  };
}

// EOF: js/ai-lookup.js