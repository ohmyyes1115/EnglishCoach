// Layer 2: AI Concise Explanation (Gemini / Groq / OpenAI / Free Fallback),
// Tap-to-Lookup Word Dictionary, TTS Read Aloud, IndexedDB Note Caching & Audio Transcription

import {
  state,
  escapeHtml,
  formatIdx,
  showGiantHud,
  copyTextSynchronously,
  savePackToDB
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
  onOpenAiSettings: () => {}
};

export function registerAiCallbacks(cbs = {}) {
  if (typeof cbs.onRenderMainStage === 'function') {
    aiCallbacks.onRenderMainStage = cbs.onRenderMainStage;
  }
  if (typeof cbs.onOpenAiSettings === 'function') {
    aiCallbacks.onOpenAiSettings = cbs.onOpenAiSettings;
  }
}

export function updateAiHeaderBadgeUI() {
  const el = document.getElementById('aiHeaderBadgeText');
  if (!el || !state.aiConfig) return;
  if (state.aiConfig.provider === 'gemini' && state.aiConfig.geminiKey) el.textContent = 'Gemini就緒';
  else if (state.aiConfig.provider === 'groq' && state.aiConfig.groqKey) el.textContent = 'Groq就緒';
  else if (state.aiConfig.provider === 'openai' && state.aiConfig.openaiKey) el.textContent = 'GPT就緒';
  else el.textContent = 'AI設定';
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

  const rawText = (item?.zh ? `中文翻譯：${item.zh}。` : '') +
    (item?.aiNotes ? `重點解析：${item.aiNotes.replace(/[•【】\[\]]/g, ' ')}。` : '') +
    (item?.aiGrammarNote ? `句型語氣：${item.aiGrammarNote}` : '');
  const fallbackText = bodyEl ? bodyEl.innerText.replace(/💡 目前使用.*/g, '').trim() : '';
  const toSpeak = (rawText || fallbackText).trim();
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
  const openKeyBtn = bodyEl.querySelector('button[data-open-ai-settings="1"]');
  if (openKeyBtn) {
    openKeyBtn.addEventListener('click', () => {
      aiCallbacks.onOpenAiSettings();
    });
  }
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

export async function callGeminiFlashConciseApi(promptText, apiKey) {
  const cleanKey = String(apiKey || '').trim();
  const models = cleanKey ? ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-3-flash-preview'] : ['gemini-3-flash-preview'];
  let lastErr = null;
  for (const modelName of models) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(cleanKey)}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          generationConfig: { temperature: 0.25, maxOutputTokens: 380 }
        })
      });
      const data = await res.json();
      if (!res.ok) {
        lastErr = new Error(data?.error?.message || `HTTP ${res.status}`);
        continue;
      }
      const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (reply) return { text: reply, modelUsed: modelName };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Gemini API 呼叫失敗');
}

let cachedGroqKeyFp = '';
let cachedGroqModelIds = null;
let cachedGroqChatModel = '';
let cachedGroqWhisperModel = '';

async function fetchGroqAvailableModelIds(apiKey) {
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

function rankGroqChatModels(availableIds) {
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
        max_tokens: 360,
        messages: [
          { role: 'system', content: '你是一位專精台灣繁體中文的車用英文口說教練，回答務必極度精簡扼要。' },
          { role: 'user', content: promptText }
        ]
      })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      cachedGroqChatModel = modelName;
      return { text: data?.choices?.[0]?.message?.content || '', modelUsed: modelName };
    }
    const errMsg = data?.error?.message || `Groq HTTP ${res.status}`;
    lastErr = new Error(errMsg);
    if (res.status === 401) break; // Invalid key, stop immediately
    if (cachedGroqChatModel === modelName) cachedGroqChatModel = '';
  }

  throw lastErr || new Error('Groq 找不到此金鑰可用的對話模型，請檢查 Groq Console 的模型權限設定');
}

export async function callOpenAiMiniConciseApi(promptText, apiKey) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${String(apiKey || '').trim()}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.25,
      max_tokens: 360,
      messages: [
        { role: 'system', content: '你是一位專精台灣繁體中文的車用英文口說教練，回答務必極度精簡扼要。' },
        { role: 'user', content: promptText }
      ]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI HTTP ${res.status}`);
  return { text: data?.choices?.[0]?.message?.content || '', modelUsed: 'gpt-4o-mini' };
}

export async function queryConfiguredAiEngine(promptText) {
  const cfg = state.aiConfig || { provider: 'gemini', geminiKey: '', groqKey: '', openaiKey: '' };
  if (cfg.provider === 'free_builtin') throw new Error('UserSelectedFreeBuiltin');
  if (cfg.provider === 'groq' && cfg.groqKey) return await callGroqConciseApi(promptText, cfg.groqKey);
  if (cfg.provider === 'openai' && cfg.openaiKey) return await callOpenAiMiniConciseApi(promptText, cfg.openaiKey);
  return await callGeminiFlashConciseApi(promptText, cfg.geminiKey || '');
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

  const item = state.currentPack?.items?.[state.currentIndex];
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

  if (item && item.wordNotes && item.wordNotes[wordKey]) {
    const cached = item.wordNotes[wordKey];
    badge.textContent = '✨ 單字快取 (0ms)';
    renderAiDrawerBodyHtml(bodyEl, formatSavedAiNotesHtml(item.zh || cached.zh, cached.notes, cached.grammar || '', false));
    return;
  }

  badge.textContent = '👆 點字即查';
  bodyEl.innerHTML = `<div class="flex items-center gap-2 text-violet-300 font-bold py-2"><i class="fa-solid fa-spinner animate-spin"></i><span>正在查詢「${escapeHtml(cleanWord)}」在本句中的精準字義...</span></div>`;

  const prompt = `請針對英文句子："${fullSentence}" 裡面的單字 "${cleanWord}" 用台灣繁體中文極簡回答（總字數 90 字內）：\n中譯：(整句話的自然繁體中文翻譯)\n• 【${cleanWord}】音標、詞性、在這句話裡的精準中文意思\n• 常見搭配詞或同義替換 1 條\n句型：(該字在本句中的語氣或用法提示 1 短句)`;
  try {
    const res = await queryConfiguredAiEngine(prompt);
    badge.textContent = `🤖 ${res.modelUsed}`;
    const parsed = parseAiStructuredResponse(res.text);
    if (item) {
      if (!item.wordNotes) item.wordNotes = {};
      item.wordNotes[wordKey] = { zh: parsed.zh || item.zh, notes: parsed.notes, grammar: parsed.grammar };
    }
    await persistZhAndNotesToCurrentItem(parsed.zh, item?.aiNotes || parsed.notes, item?.aiGrammarNote || parsed.grammar);
    renderAiDrawerBodyHtml(bodyEl, formatSavedAiNotesHtml(parsed.zh || item?.zh, parsed.notes, parsed.grammar, false));
    return;
  } catch (e) {}

  badge.textContent = '⚡ 免金鑰即時字典';
  const [wordZh, sentenceZh, dictInfo] = await Promise.all([
    fetchFreeGoogleTranslateZhTW(cleanWord),
    (item && item.zh) ? Promise.resolve(item.zh) : fetchFreeGoogleTranslateZhTW(fullSentence),
    fetchFreeDictionaryEntry(cleanWord)
  ]);
  const ph = dictInfo?.phonetic ? ` ${dictInfo.phonetic}` : '';
  const defs = dictInfo?.meanings?.length ? `\n• 詞性與釋義：${dictInfo.meanings.join(' / ')}` : '';
  const noteBlock = `【${cleanWord}】${ph}：${wordZh || '請見下方釋義'}${defs}`;
  if (item) {
    if (!item.wordNotes) item.wordNotes = {};
    item.wordNotes[wordKey] = { zh: sentenceZh || item.zh, notes: noteBlock, grammar: '' };
  }
  await persistZhAndNotesToCurrentItem(sentenceZh, item?.aiNotes || noteBlock);
  const hasKey = Boolean(state.aiConfig?.geminiKey || state.aiConfig?.groqKey || state.aiConfig?.openaiKey);
  renderAiDrawerBodyHtml(bodyEl, formatSavedAiNotesHtml(sentenceZh || item?.zh, noteBlock, '', !hasKey));
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

  if (!forceRefresh && item.aiNotes && item.aiNotes.trim()) {
    badge.textContent = '✨ 已存快取 (0ms)';
    renderAiDrawerBodyHtml(bodyEl, formatSavedAiNotesHtml(item.zh, item.aiNotes, item.aiGrammarNote || '', false));
    return;
  }

  bodyEl.innerHTML = `<div class="flex items-center gap-2 text-violet-300 font-bold py-2"><i class="fa-solid fa-spinner animate-spin"></i><span>正在翻譯並拆解本句重點單字與句型...</span></div>`;

  const prompt = `請幫我用台灣繁體中文極簡解析這句英文口說："${cleanSentence}"\n請嚴格依照以下格式回覆（總字數 120 字內）：\n中譯：(最自然道地的繁體中文翻譯)\n• (核心單字或片語 1：音標＋中文意思)\n• (核心單字或片語 2：音標＋中文意思)\n• (核心單字或片語 3：音標＋中文意思)\n句型：(1句話秒懂這句的文法結構與語氣用法)`;
  try {
    const res = await queryConfiguredAiEngine(prompt);
    badge.textContent = `🤖 ${res.modelUsed}`;
    const parsed = parseAiStructuredResponse(res.text);
    if (parsed.zh) item.zh = parsed.zh;
    await persistZhAndNotesToCurrentItem(parsed.zh, parsed.notes, parsed.grammar);
    renderAiDrawerBodyHtml(bodyEl, formatSavedAiNotesHtml(parsed.zh || item.zh, parsed.notes, parsed.grammar, false));
    return;
  } catch (e) {}

  badge.textContent = '⚡ 免金鑰智慧翻譯';
  const translatedZh = (forceRefresh ? '' : item.zh) || (await fetchFreeGoogleTranslateZhTW(cleanSentence));
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
  if (translatedZh) item.zh = translatedZh;
  await persistZhAndNotesToCurrentItem(
    translatedZh,
    finalNotes,
    '可點擊上方英文句子中的任一單字即查音標與字義，或點「🔊 唸出中文解析」用聽的學。'
  );
  const hasKey = Boolean(state.aiConfig?.geminiKey || state.aiConfig?.groqKey || state.aiConfig?.openaiKey);
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
  const cfg = state.aiConfig || { provider: 'gemini', geminiKey: '', groqKey: '', openaiKey: '' };
  if (cfg.provider === 'groq' && cfg.groqKey) {
    return { type: 'groq', key: cfg.groqKey };
  }
  if (cfg.provider === 'openai' && cfg.openaiKey) {
    return { type: 'openai', key: cfg.openaiKey };
  }
  if (cfg.provider === 'gemini' && cfg.geminiKey) {
    return { type: 'gemini', key: cfg.geminiKey };
  }
  // Fallback to whichever API key is already filled (prefer Whisper for exact timestamps)
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
    : 'https://api.openai.com/openai/v1/audio/transcriptions';

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
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash'];
  const prompt = [
    'Transcribe all spoken English in this audio accurately with proper capitalization and punctuation.',
    'Output strictly one natural sentence per line using this exact format:',
    'English sentence || 自然流暢的台灣繁體中文翻譯',
    'Rules: Do NOT include line numbers, timestamps, speaker labels, markdown bullets, or any extra explanation.'
  ].join('\n');

  const base64Audio = chunk.toBase64();
  let lastErr = null;

  for (const modelName of models) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(cleanKey)}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: 'audio/wav', data: base64Audio } }
            ]
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
        })
      });
      const data = await res.json();
      if (!res.ok) {
        lastErr = new Error(data?.error?.message || `Gemini HTTP ${res.status}`);
        continue;
      }
      const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!reply) continue;

      const entries = reply
        .split('\n')
        .map(line => line.replace(/^[\-\*•\s]+/, '').replace(/^\d+[\.\)、\-\s]+/, '').trim())
        .filter(Boolean)
        .filter(line => !/^```/.test(line))
        .map(line => {
          const parts = line.split('||');
          return {
            en: (parts[0] || '').trim(),
            zh: (parts[1] || '').trim()
          };
        })
        .filter(item => item.en);

      return { modelUsed: modelName, entries };
    } catch (err) {
      lastErr = err;
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
      const prevEndsPunct = /[.!?]["'”’)\]]*$/.test(prevLine.en.trim());
      const curStartsLower = /^[a-z]/.test(curLine.en.trim());
      const gap = curSeg.startSec - prevSeg.endSec;
      const combinedDur = curSeg.endSec - prevSeg.startSec;

      // Rejoin fragments that Whisper split mid-sentence (no end punctuation + lowercase continuation)
      if (!prevEndsPunct && curStartsLower && gap <= 0.65 && combinedDur <= 9.5) {
        prevLine.en = `${prevLine.en.trim()} ${curLine.en.trim()}`;
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
      : 'Gemini 雙語聽打';
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