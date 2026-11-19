// Layer 2: AI Concise Explanation (Gemini / Groq / OpenAI / Free Fallback),
// Tap-to-Lookup Word Dictionary, TTS Read Aloud & IndexedDB Note Caching

import {
  state,
  escapeHtml,
  formatIdx,
  showGiantHud,
  copyTextSynchronously,
  savePackToDB
} from './state-storage.js';

import { unlockiOSAudioAndSpeechSynchronously } from './audio-processor.js';
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

export async function callGroqConciseApi(promptText, apiKey) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${String(apiKey || '').trim()}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.25,
      max_tokens: 360,
      messages: [
        { role: 'system', content: '你是一位專