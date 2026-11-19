// Layer 3: Application Entry Point, UI Rendering, Modal Controllers & Event Bindings

import {
  SPEED_STEPS,
  state,
  cloneDefaultKeymap,
  safeOn,
  escapeHtml,
  formatIdx,
  formatTimeSec,
  showGiantHud,
  savePackToDB,
  loadAllPacksFromDB,
  deletePackFromDB,
  savePrefsSync,
  loadPrefsSync,
  loadAiConfigSync,
  saveAiConfigSync,
  loadKeymapSync,
  saveKeymapSync
} from './state-storage.js';

import {
  getAudioContext,
  createDefaultBuiltInPack,
  precomputeAudioEnvelope,
  refreshVadWorkbenchPreview,
  renderVadChunkListUI,
  autoFindMatchingDbThreshold,
  generateSimulatedGpt10SentenceLongAudio,
  buildSplitPackFromVad,
  generateAndDownloadDemoZip,
  importZipOrMultiFiles
} from './audio-processor.js';

import {
  registerPlayerCallbacks,
  pausePlaybackInPlace,
  playCurrentSentenceClip,
  handleClipEnded,
  setupWatchdogTimer,
  actionPrevSentence,
  actionRestartCurrentSentence,
  actionTogglePlayPause,
  actionNextSentence,
  actionCycleSpeed,
  actionToggleInfiniteLoop,
  actionResetToFirstSentence,
  actionMergeWithNextSentence,
  actionUndoMergeSentence,
  actionNormalizeCurrentPackVolume,
  triggerCopyCurrentSentence
} from './player-engine.js';

import {
  registerAiCallbacks,
  updateAiHeaderBadgeUI,
  speakChineseExplanationAloud,
  fetchFreeGoogleTranslateZhTW,
  callGeminiFlashConciseApi,
  callGroqConciseApi,
  callOpenAiMiniConciseApi,
  handleTapEnglishWordLookup,
  actionAiExplainCurrentSentence,
  actionCopySentenceWithAiPrompt
} from './ai-lookup.js';

// ==========================================
// UI RENDERING & INTERACTIVE WORD TOKENS
// ==========================================
function renderInteractiveEnglishTokens(enText) {
  const container = document.getElementById('displayEnglish');
  if (!container) return;
  container.innerHTML = '';

  if (state.subMode === 'hide') {
    container.textContent = '🙈 盲聽跟讀模式（點擊右上角可顯示字幕）';
    return;
  }

  const tokens = String(enText || '').split(/(\s+)/);
  tokens.forEach((tok) => {
    if (/^\s+$/.test(tok)) {
      container.appendChild(document.createTextNode(tok));
      return;
    }
    const cleanAlpha = tok.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '');
    // Keep leading numbering like "1." non-lookup
    if (!cleanAlpha || /^\d+$/.test(cleanAlpha)) {
      const spanNum = document.createElement('span');
      spanNum.className = 'text-sky-400 mr-1';
      spanNum.textContent = tok;
      container.appendChild(spanNum);
      return;
    }
    const span = document.createElement('span');
    span.className = 'word-token';
    if (state.activeLookupWord && state.activeLookupWord.toLowerCase() === cleanAlpha.toLowerCase()) {
      span.classList.add('word-token-active');
    }
    span.textContent = tok;
    span.addEventListener('click', (e) => {
      e.stopPropagation();
      handleTapEnglishWordLookup(cleanAlpha, span);
    });
    container.appendChild(span);
  });
}

function renderCoursePackDropdown() {
  const sel = document.getElementById('selectCoursePack');
  if (!sel) return;
  sel.innerHTML = '';
  state.packs.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    const total = (p.items || []).length;
    const savedIdx = (state.packProgressMap[p.id] || 0) + 1;
    opt.textContent = `${p.name} (進度 ${formatIdx(Math.min(savedIdx, total))}/${formatIdx(total)})`;
    if (state.currentPack && state.currentPack.id === p.id) opt.selected = true;
    sel.appendChild(opt);
  });
}

function renderRepeatAndGapButtons() {
  document.querySelectorAll('.repeat-btn').forEach((btn) => {
    const val = Number(btn.getAttribute('data-repeat'));
    const isActive = val === state.repeatTarget;
    if (val === 999) {
      btn.textContent = isActive
        ? `♾️ 無限單句 (再按回 ${state.previousFiniteRepeatTarget}次)`
        : '♾️ 無限單句';
      btn.className = isActive
        ? 'repeat-btn px-2.5 py-1 rounded-lg bg-amber-400 text-slate-950 font-black transition shadow'
        : 'repeat-btn px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 font-bold transition';
    } else {
      btn.className = isActive
        ? 'repeat-btn px-2.5 py-1 rounded-lg bg-emerald-500 text-slate-950 font-black transition shadow'
        : 'repeat-btn px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 font-bold transition';
    }
  });

  document.querySelectorAll('.gap-btn').forEach((btn) => {
    const g = btn.getAttribute('data-gap');
    const isActive = g === state.gapMode;
    btn.className = isActive
      ? 'gap-btn px-2.5 py-1 rounded-lg bg-sky-500 text-slate-950 font-black transition shadow'
      : 'gap-btn px-2.5 py-1 rounded-lg bg-slate-800 text-slate-300 font-bold transition';
  });
}

function updatePlayPauseUI(customStatusText = '') {
  const btn = document.getElementById('btnControlPlay');
  const icon = document.getElementById('iconPlayPause');
  const label = document.getElementById('labelPlayPause');
  const dot = document.getElementById('statusDot');
  const statText = document.getElementById('statStatusText');
  if (!btn || !icon || !label || !dot || !statText) return;

  if (state.isPlaying) {
    btn.className = 'bg-amber-400 hover:bg-amber-300 active:scale-95 border-2 border-amber-200 rounded-2xl p-2.5 sm:p-3.5 flex flex-col items-center justify-between transition shadow-xl shadow-amber-400/25 text-slate-950';
    icon.className = 'fa-solid fa-pause text-2xl sm:text-3xl my-2';
    label.textContent = '暫停播放';
    dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shrink-0';
    const isInf = state.repeatTarget >= 999;
    statText.textContent = customStatusText || (state.isInGap ? '跟讀留白中...' : `播放中 (${state.repeatCountCurrent}/${isInf ? '∞' : state.repeatTarget})`);
    statText.className = 'text-xs sm:text-sm font-extrabold text-emerald-300 truncate';
  } else {
    btn.className = 'bg-sky-500 hover:bg-sky-400 active:scale-95 border-2 border-sky-300 rounded-2xl p-2.5 sm:p-3.5 flex flex-col items-center justify-between transition shadow-xl shadow-sky-500/25 text-slate-950';
    icon.className = 'fa-solid fa-play text-2xl sm:text-3xl my-2';
    label.textContent = state.pausedOffsetSec > 0.08 ? '繼續播放' : '開始播放';
    dot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 shrink-0';
    statText.textContent = customStatusText || (state.pausedOffsetSec > 0.08 ? `已暫停 (${formatTimeSec(state.pausedOffsetSec)})` : '待命就緒');
    statText.className = 'text-xs sm:text-sm font-extrabold text-amber-300 truncate';
  }
}

function renderMainStage() {
  if (!state.currentPack || !state.currentPack.items.length) return;
  const total = state.currentPack.items.length;
  if (state.currentIndex >= total) state.currentIndex = 0;
  const item = state.currentPack.items[state.currentIndex];

  document.getElementById('statCurrentIdx').textContent = formatIdx(state.currentIndex + 1);
  document.getElementById('statTotalIdx').textContent = formatIdx(total);

  const isInf = state.repeatTarget >= 999;
  document.getElementById('statRepeatText').textContent = isInf
    ? `${state.repeatCountCurrent}/∞`
    : `${state.repeatCountCurrent}/${state.repeatTarget}`;

  const dotsEl = document.getElementById('repeatDotsContainer');
  if (dotsEl) {
    dotsEl.innerHTML = '';
    const dotCount = isInf ? 3 : Math.min(5, state.repeatTarget);
    for (let i = 1; i <= dotCount; i++) {
      const d = document.createElement('span');
      const active = isInf || i <= state.repeatCountCurrent;
      d.className = `w-2.5 h-2.5 rounded-full ${active ? 'bg-emerald-400' : 'bg-slate-700'}`;
      dotsEl.appendChild(d);
    }
  }

  const speed = SPEED_STEPS[state.speedIndex] || 1.0;
  document.getElementById('statSpeedText').textContent = `${speed.toFixed(2)}x`;
  document.getElementById('btnSpeedLabel').textContent = `${speed.toFixed(2)}x 語速`;

  document.getElementById('badgeAudioSource').textContent = state.currentPack.audioModeLabel || 'WAV 獨立音檔';
  const dur = Number(item.durationSec) || 2.8;
  document.getElementById('badgeClipDuration').textContent = `${dur.toFixed(1)}s`;
  document.getElementById('timeTotal').textContent = formatTimeSec(dur);

  const demoBtn = document.getElementById('btnDemoVoiceMode');
  if (demoBtn) {
    demoBtn.classList.toggle('hidden', !state.currentPack.isDemoTTS);
    demoBtn.textContent = state.demoVoiceMode === 'tts_and_pad'
      ? '🔊 範例人聲：語音+墊音'
      : '🔊 範例人聲：僅TTS語音';
  }

  const aiBadge = document.getElementById('badgeAiParsed');
  if (aiBadge) {
    aiBadge.classList.toggle('hidden', !(item.aiNotes && item.aiNotes.trim()));
  }

  const undoBtn = document.getElementById('btnUndoMerge');
  if (undoBtn) {
    undoBtn.classList.toggle('hidden', !state.undoMergeSnapshot);
  }

  const mergeModeBtn = document.getElementById('btnToggleMergeMode');
  if (mergeModeBtn) {
    mergeModeBtn.textContent = state.mergeSubMode === 'audio_only_shift'
      ? '模式:僅合音檔(修錯位)'
      : '模式:音檔+字幕同合';
  }

  const subBtn = document.getElementById('btnToggleSubMode');
  if (subBtn) {
    subBtn.textContent = state.subMode === 'both'
      ? '👁️ 字幕：英+中'
      : (state.subMode === 'en' ? '👁️ 字幕：僅英文' : '🙈 字幕：隱藏');
  }

  renderInteractiveEnglishTokens(item.en);

  const zhEl = document.getElementById('displayChinese');
  if (zhEl) {
    if (state.subMode === 'both') {
      zhEl.classList.remove('hidden');
      zhEl.textContent = item.zh || '（尚無中文字幕，點擊右上「💡 AI 簡答」自動補齊並儲存）';
    } else {
      zhEl.classList.add('hidden');
    }
  }

  renderRepeatAndGapButtons();
  renderCoursePackDropdown();
  updatePlayPauseUI();
}

function openAiSettingsModal() {
  const modalAi = document.getElementById('modalAiSettings');
  const cfg = state.aiConfig || loadAiConfigSync();
  const radio = document.querySelector(`input[name="aiProviderSelect"][value="${cfg.provider}"]`);
  if (radio) radio.checked = true;
  document.getElementById('inputGeminiApiKey').value = cfg.geminiKey || '';
  document.getElementById('inputGroqApiKey').value = cfg.groqKey || '';
  document.getElementById('inputOpenAiApiKey').value = cfg.openaiKey || '';
  modalAi?.classList.remove('hidden');
}

// ==========================================
// APPLICATION INITIALIZATION
// ==========================================
async function initApplication() {
  registerPlayerCallbacks({
    onRenderMainStage: renderMainStage,
    onUpdatePlayPauseUI: updatePlayPauseUI
  });
  registerAiCallbacks({
    onRenderMainStage: renderMainStage,
    onOpenAiSettings: openAiSettingsModal
  });

  state.aiConfig = loadAiConfigSync();
  updateAiHeaderBadgeUI();
  state.keymap = loadKeymapSync();

  // 1. Load default built-in pack synchronously so UI never hangs
  const builtInPack = createDefaultBuiltInPack();
  state.packs = [builtInPack];
  state.currentPack = builtInPack;

  const prefs = loadPrefsSync();
  if (prefs) {
    state.packProgressMap = prefs.packProgressMap || {};
    state.repeatTarget = Number(prefs.repeatTarget) || 2;
    state.previousFiniteRepeatTarget = Number(prefs.previousFiniteRepeatTarget) || 2;
    state.gapMode = prefs.gapMode || '1';
    state.speedIndex = Number(prefs.speedIndex) || 0;
    state.subMode = prefs.subMode || 'both';
    state.mergeSubMode = prefs.mergeSubMode || 'audio_only_shift';
    state.demoVoiceMode = prefs.demoVoiceMode || 'tts_and_pad';
  }

  renderMainStage();

  // 2. Load saved packs from IndexedDB asynchronously
  const dbPacks = await loadAllPacksFromDB();
  if (dbPacks && dbPacks.length > 0) {
    const map = new Map();
    map.set(builtInPack.id, builtInPack);
    dbPacks.forEach(p => {
      if (p && p.id && Array.isArray(p.items) && p.items.length > 0) {
        map.set(p.id, p);
      }
    });
    state.packs = Array.from(map.values());
  }

  if (prefs && prefs.lastPackId) {
    const found = state.packs.find(p => p.id === prefs.lastPackId);
    if (found) state.currentPack = found;
  }

  const savedIdx = Number(state.packProgressMap[state.currentPack.id]) || 0;
  if (savedIdx > 0 && savedIdx < state.currentPack.items.length) {
    state.currentIndex = savedIdx;
    const toast = document.getElementById('badgeResumeToast');
    if (toast) {
      toast.textContent = `📌 已接續上次進度 (#${formatIdx(savedIdx + 1)})`;
      toast.classList.remove('hidden');
      setTimeout(() => toast.classList.add('hidden'), 4000);
    }
  }

  renderMainStage();
  setupWatchdogTimer();
}

// ==========================================
// EVENT BINDINGS & MODAL CONTROLLERS
// ==========================================
function bindAllEvents() {
  const masterAudio = document.getElementById('masterAudio');
  if (masterAudio) {
    masterAudio.addEventListener('ended', handleClipEnded);
  }

  // Main 5 Controls + Long-Press Speed on Play Button
  safeOn('btnControlPrev', 'click', actionPrevSentence);
  safeOn('btnControlRestart', 'click', actionRestartCurrentSentence);
  safeOn('btnControlNext', 'click', actionNextSentence);
  safeOn('btnControlSpeed', 'click', actionCycleSpeed);
  safeOn('cardSpeedQuick', 'click', actionCycleSpeed);
  safeOn('btnResetToFirst', 'click', actionResetToFirstSentence);

  let playPressTimer = null;
  let playLongPressTriggered = false;
  const playBtn = document.getElementById('btnControlPlay');
  if (playBtn) {
    const startPress = () => {
      playLongPressTriggered = false;
      playPressTimer = setTimeout(() => {
        playLongPressTriggered = true;
        actionCycleSpeed();
      }, 500);
    };
    const endPress = () => {
      if (playPressTimer) {
        clearTimeout(playPressTimer);
        playPressTimer = null;
      }
    };
    playBtn.addEventListener('mousedown', startPress);
    playBtn.addEventListener('touchstart', startPress, { passive: true });
    playBtn.addEventListener('mouseup', endPress);
    playBtn.addEventListener('mouseleave', endPress);
    playBtn.addEventListener('touchend', endPress);
    playBtn.addEventListener('touchcancel', endPress);
    playBtn.addEventListener('click', () => {
      if (!playLongPressTriggered) actionTogglePlayPause();
    });
  }

  // Repeat & Gap Buttons
  document.querySelectorAll('.repeat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = Number(btn.getAttribute('data-repeat'));
      if (val === 999) {
        actionToggleInfiniteLoop();
      } else {
        state.repeatTarget = val;
        state.previousFiniteRepeatTarget = val;
        savePrefsSync();
        renderMainStage();
      }
    });
  });

  document.querySelectorAll('.gap-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.gapMode = btn.getAttribute('data-gap');
      savePrefsSync();
      renderMainStage();
    });
  });

  // Stage Top Toolbar Buttons
  safeOn('btnAiExplain', 'click', () => actionAiExplainCurrentSentence(false));
  safeOn('badgeAiParsed', 'click', () => actionAiExplainCurrentSentence(false));
  safeOn('btnForceReExplain', 'click', () => actionAiExplainCurrentSentence(true));
  safeOn('btnSpeakChineseNote', 'click', speakChineseExplanationAloud);
  safeOn('btnCopyWithPrompt', 'click', actionCopySentenceWithAiPrompt);
  safeOn('btnCloseAiDrawer', 'click', () => document.getElementById('aiExplainDrawer')?.classList.add('hidden'));

  safeOn('btnCopySentence', 'click', triggerCopyCurrentSentence);
  safeOn('btnNormalizeCurrentPack', 'click', actionNormalizeCurrentPackVolume);
  safeOn('btnMergeNextSentence', 'click', actionMergeWithNextSentence);
  safeOn('btnUndoMerge', 'click', actionUndoMergeSentence);
  safeOn('btnToggleMergeMode', 'click', () => {
    state.mergeSubMode = state.mergeSubMode === 'audio_only_shift' ? 'both_audio_and_text' : 'audio_only_shift';
    savePrefsSync();
    renderMainStage();
  });
  safeOn('btnToggleSubMode', 'click', () => {
    const order = ['both', 'en', 'hide'];
    state.subMode = order[(order.indexOf(state.subMode) + 1) % order.length];
    savePrefsSync();
    renderMainStage();
  });
  safeOn('btnDemoVoiceMode', 'click', () => {
    state.demoVoiceMode = state.demoVoiceMode === 'tts_and_pad' ? 'tts_only' : 'tts_and_pad';
    savePrefsSync();
    renderMainStage();
  });

  // Course Pack Selector & Delete
  safeOn('selectCoursePack', 'change', (e) => {
    const id = e.target.value;
    const found = state.packs.find(p => p.id === id);
    if (found) {
      pausePlaybackInPlace('切換教材');
      state.currentPack = found;
      state.currentIndex = Number(state.packProgressMap[found.id]) || 0;
      state.repeatCountCurrent = 1;
      state.pausedOffsetSec = 0;
      savePrefsSync();
      renderMainStage();
    }
  });

  safeOn('btnDeletePack', 'click', async () => {
    if (!state.currentPack || state.currentPack.id === 'default_pack') {
      showGiantHud('ℹ️', '預設教材無法刪除', '可匯入自己的長音檔或 ZIP 新增課程', 'border-sky-400/90');
      return;
    }
    const delId = state.currentPack.id;
    await deletePackFromDB(delId);
    state.packs = state.packs.filter(p => p.id !== delId);
    state.currentPack = state.packs[0];
    state.currentIndex = 0;
    savePrefsSync();
    renderMainStage();
    showGiantHud('🗑️', '已刪除教材包', state.currentPack.name);
  });

  // Modal: AI Settings
  const modalAi = document.getElementById('modalAiSettings');
  safeOn('btnOpenAiSettings', 'click', openAiSettingsModal);
  safeOn('btnDrawerOpenAiKey', 'click', openAiSettingsModal);
  safeOn('btnCloseAiSettings', 'click', () => modalAi?.classList.add('hidden'));
  safeOn('btnToggleShowKey', 'click', () => {
    const g = document.getElementById('inputGeminiApiKey');
    const next = g.type === 'password' ? 'text' : 'password';
    g.type = next;
    document.getElementById('inputGroqApiKey').type = next;
    document.getElementById('inputOpenAiApiKey').type = next;
  });
  safeOn('btnSaveAiSettings', 'click', () => {
    const provider = document.querySelector('input[name="aiProviderSelect"]:checked')?.value || 'gemini';
    const geminiKey = document.getElementById('inputGeminiApiKey').value;
    const groqKey = document.getElementById('inputGroqApiKey').value;
    const openaiKey = document.getElementById('inputOpenAiApiKey').value;
    saveAiConfigSync({ provider, geminiKey, groqKey, openaiKey });
    updateAiHeaderBadgeUI();
    modalAi?.classList.add('hidden');
    showGiantHud('🔑', '已儲存 AI 設定', '可點擊單字或「💡 AI 簡答」立即體驗', 'border-violet-400/90');
  });
  safeOn('btnClearAiKeys', 'click', () => {
    document.getElementById('inputGeminiApiKey').value = '';
    document.getElementById('inputGroqApiKey').value = '';
    document.getElementById('inputOpenAiApiKey').value = '';
    saveAiConfigSync({ provider: 'free_builtin', geminiKey: '', groqKey: '', openaiKey: '' });
    updateAiHeaderBadgeUI();
    document.getElementById('aiTestStatusText').textContent = '已清除金鑰，切換為免金鑰模式';
  });
  safeOn('btnTestAiConnection', 'click', async () => {
    const st = document.getElementById('aiTestStatusText');
    const provider = document.querySelector('input[name="aiProviderSelect"]:checked')?.value || 'gemini';
    const geminiKey = document.getElementById('inputGeminiApiKey').value.trim();
    const groqKey = document.getElementById('inputGroqApiKey').value.trim();
    const openaiKey = document.getElementById('inputOpenAiApiKey').value.trim();
    st.textContent = '⏳ 測試連線中...';
    try {
      if (provider === 'gemini' && geminiKey) {
        const r = await callGeminiFlashConciseApi('請回答「連線成功」四個字。', geminiKey);
        st.textContent = `✅ Gemini (${r.modelUsed}) 連線成功！`;
      } else if (provider === 'groq' && groqKey) {
        const r = await callGroqConciseApi('請回答「連線成功」四個字。', groqKey);
        st.textContent = `✅ Groq (${r.modelUsed}) 連線成功！`;
      } else if (provider === 'openai' && openaiKey) {
        const r = await callOpenAiMiniConciseApi('請回答「連線成功」四個字。', openaiKey);
        st.textContent = `✅ OpenAI (${r.modelUsed}) 連線成功！`;
      } else {
        const zh = await fetchFreeGoogleTranslateZhTW('Keep me posted.');
        st.textContent = `✅ 免金鑰翻譯連線成功 (${zh})`;
      }
    } catch (err) {
      st.textContent = `❌ 失敗：${err.message}`;
    }
  });

  // Modal: Sentence List
  const modalList = document.getElementById('modalSentenceList');
  safeOn('btnOpenSentenceList', 'click', () => {
    const container = document.getElementById('sentenceListContainer');
    container.innerHTML = '';
    (state.currentPack?.items || []).forEach((it, idx) => {
      const active = idx === state.currentIndex;
      const div = document.createElement('div');
      div.className = `p-3 rounded-2xl border cursor-pointer transition flex items-center justify-between gap-2 ${active ? 'bg-sky-500/20 border-sky-400 text-white' : 'bg-slate-950 border-slate-800 hover:border-slate-700 text-slate-300'}`;
      div.innerHTML = `
        <div class="space-y-0.5 min-w-0 flex-1">
          <div class="text-xs font-extrabold truncate">${escapeHtml(it.en)}</div>
          <div class="text-[11px] text-sky-400 truncate">${escapeHtml(it.zh || '')}</div>
        </div>
        <span class="font-mono text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300 shrink-0">#${formatIdx(idx + 1)}</span>
      `;
      div.addEventListener('click', () => {
        state.currentIndex = idx;
        state.repeatCountCurrent = 1;
        state.pausedOffsetSec = 0;
        savePrefsSync();
        modalList?.classList.add('hidden');
        playCurrentSentenceClip(false, 0);
      });
      container.appendChild(div);
    });
    modalList?.classList.remove('hidden');
  });
  safeOn('btnCloseSentenceList', 'click', () => modalList?.classList.add('hidden'));
  safeOn('btnModalResetFirst', 'click', () => {
    modalList?.classList.add('hidden');
    actionResetToFirstSentence();
  });

  // Modal: Changelog
  safeOn('btnOpenChangelog', 'click', () => document.getElementById('modalChangelog')?.classList.remove('hidden'));
  safeOn('btnCloseChangelog', 'click', () => document.getElementById('modalChangelog')?.classList.add('hidden'));

  // Modal: Keymap (Bluetooth Page Turner / Keyboard)
  const modalKeymap = document.getElementById('modalKeymap');
  const renderKeymapRows = () => {
    const box = document.getElementById('keymapListContainer');
    if (!box) return;
    box.innerHTML = '';
    Object.entries(state.keymap).forEach(([k, info]) => {
      const row = document.createElement('div');
      row.className = 'p-3 rounded-2xl bg-slate-950 border border-slate-800 flex items-center justify-between gap-2';
      row.innerHTML = `
        <div>
          <div class="font-bold text-white">${escapeHtml(info.label)}</div>
          <div class="font-mono text-[11px] text-amber-300 mt-0.5">${escapeHtml((info.codes || []).join(' / '))}</div>
        </div>
        <button type="button" data-k="${k}" class="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-sky-500 hover:text-slate-950 font-bold text-xs transition">
          ${state.listeningKeyAction === k ? '請按翻頁器按鍵...' : '學習按鍵'}
        </button>
      `;
      row.querySelector('button').addEventListener('click', () => {
        state.listeningKeyAction = k;
        renderKeymapRows();
      });
      box.appendChild(row);
    });
  };
  safeOn('btnOpenKeymapModal', 'click', () => {
    state.listeningKeyAction = null;
    renderKeymapRows();
    modalKeymap?.classList.remove('hidden');
  });
  safeOn('btnCloseKeymapModal', 'click', () => {
    state.listeningKeyAction = null;
    modalKeymap?.classList.add('hidden');
  });
  safeOn('btnDoneKeymap', 'click', () => {
    state.listeningKeyAction = null;
    modalKeymap?.classList.add('hidden');
  });
  safeOn('btnResetDefaultKeys', 'click', () => {
    saveKeymapSync(cloneDefaultKeymap());
    renderKeymapRows();
  });

  // Global Keyboard / Bluetooth Page Turner Interceptor
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    const code = e.code || e.key;
    if (state.listeningKeyAction) {
      e.preventDefault();
      const act = state.listeningKeyAction;
      if (!state.keymap[act].codes.includes(code)) {
        state.keymap[act].codes.unshift(code);
      }
      state.listeningKeyAction = null;
      saveKeymapSync(state.keymap);
      renderKeymapRows();
      return;
    }
    const match = (act) => (state.keymap[act]?.codes || []).includes(code);
    if (match('prev')) { e.preventDefault(); actionPrevSentence(); }
    else if (match('restart')) { e.preventDefault(); actionRestartCurrentSentence(); }
    else if (match('play')) { e.preventDefault(); actionTogglePlayPause(); }
    else if (match('next')) { e.preventDefault(); actionNextSentence(); }
    else if (match('speed')) { e.preventDefault(); actionCycleSpeed(); }
    else if (match('loop')) { e.preventDefault(); actionToggleInfiniteLoop(); }
    else if (match('merge')) { e.preventDefault(); actionMergeWithNextSentence(); }
    else if (match('copy')) { e.preventDefault(); triggerCopyCurrentSentence(); }
    else if (match('ai')) { e.preventDefault(); actionAiExplainCurrentSentence(false); }
  });

  // Modal: Import & Smart VAD Splitter Workbench (Tab A + Tab B)
  const modalImport = document.getElementById('modalImport');
  const tabBtnLong = document.getElementById('tabBtnLongAudio');
  const tabBtnZip = document.getElementById('tabBtnZipMulti');

  const setImportTab = (mode) => {
    const isLong = mode === 'long';
    document.getElementById('panelLongAudio')?.classList.toggle('hidden', !isLong);
    document.getElementById('panelZipMulti')?.classList.toggle('hidden', isLong);
    document.getElementById('btnConfirmSaveSplitPack')?.classList.toggle('hidden', !isLong);
    document.getElementById('btnConfirmZipImport')?.classList.toggle('hidden', isLong);

    if (tabBtnLong && tabBtnZip) {
      tabBtnLong.className = isLong
        ? 'flex-1 py-2 px-3 rounded-xl bg-sky-500 text-slate-950 font-black text-xs flex items-center justify-center gap-1.5 transition'
        : 'flex-1 py-2 px-3 rounded-xl bg-slate-800 text-slate-300 font-bold text-xs flex items-center justify-center gap-1.5 transition';
      tabBtnZip.className = !isLong
        ? 'flex-1 py-2 px-3 rounded-xl bg-sky-500 text-slate-950 font-black text-xs flex items-center justify-center gap-1.5 transition'
        : 'flex-1 py-2 px-3 rounded-xl bg-slate-800 text-slate-300 font-bold text-xs flex items-center justify-center gap-1.5 transition';
    }
  };

  safeOn('btnOpenImportModal', 'click', () => {
    pausePlaybackInPlace('開啟匯入工作台');
    modalImport?.classList.remove('hidden');
  });
  safeOn('btnCloseImportModal', 'click', () => modalImport?.classList.add('hidden'));
  safeOn('btnCancelImport', 'click', () => modalImport?.classList.add('hidden'));
  safeOn('tabBtnLongAudio', 'click', () => setImportTab('long'));
  safeOn('tabBtnZipMulti', 'click', () => setImportTab('zip'));

  // Tab A: VAD Long Audio Workbench
  ['sliderVadDb', 'sliderVadSilenceMs', 'sliderVadMinClipMs', 'sliderVadPadMs'].forEach(id => {
    safeOn(id, 'input', refreshVadWorkbenchPreview);
  });
  safeOn('textareaLongSubs', 'input', renderVadChunkListUI);
  safeOn('chkKeepLineNumbers', 'change', renderVadChunkListUI);
  safeOn('btnAutoFindDbThreshold', 'click', autoFindMatchingDbThreshold);
  safeOn('btnAiTranscribeLongAudio', 'click', async () => {
    if (!state.vadAudioBuffer) {
      showGiantHud('⚠️', '請先選擇長音檔', '請先在左側載入 .mp3 / .wav / .m4a 後再點聽打', 'border-amber-400/90');
      return;
    }
    const btn = document.getElementById('btnAiTranscribeLongAudio');
    const statusEl = document.getElementById('aiTranscribeStatus');
    const textarea = document.getElementById('textareaLongSubs');
    const keepNumbers = document.getElementById('chkKeepLineNumbers')?.checked;

    if (btn) btn.disabled = true;
    if (statusEl) {
      statusEl.classList.remove('hidden');
      statusEl.textContent = '⏳ 準備開始 AI 自動聽打...';
    }

    try {
      const result = await transcribeLongAudioWithAi(state.vadAudioBuffer, (msg) => {
        if (statusEl) statusEl.textContent = msg;
      });

      const formattedText = result.lines.map((item, idx) => {
        const cleanEn = String(item.en || '').replace(/^\d+[\.\)、\-\s]+/, '').trim();
        const enPart = keepNumbers ? `${idx + 1}. ${cleanEn}` : cleanEn;
        return item.zh ? `${enPart} || ${item.zh}` : enPart;
      }).join('\n');

      if (textarea) textarea.value = formattedText;

      if (result.segments && result.segments.length > 0) {
        state.vadSegments = result.segments;
        renderVadChunkListUI();
        drawVadWaveformCanvas();
        if (statusEl) {
          statusEl.textContent = `✅ ${result.modelUsed} 聽打完成：共 ${result.lines.length} 句（已自動套用精準時間軸，免調 dB 門檻）`;
        }
        showGiantHud('🎙️', `聽打完成 ${result.lines.length} 句`, `已自動套用 ${result.modelUsed} 精準切點`, 'border-emerald-400/90');
      } else {
        autoFindMatchingDbThreshold();
        if (statusEl) {
          statusEl.textContent = `✅ ${result.modelUsed} 雙語聽打完成：共 ${result.lines.length} 句（已自動尋找符合行數的 dB 門檻）`;
        }
        showGiantHud('🎙️', `雙語聽打完成 ${result.lines.length} 句`, '已自動寫入英中字幕並對齊切點', 'border-emerald-400/90');
      }
    } catch (err) {
      if (err && err.code === 'NO_API_KEY') {
        if (statusEl) {
          statusEl.textContent = '🔑 尚未設定 API Key，請先填入免費 Groq（推薦）或 Gemini 金鑰後重試';
        }
        showGiantHud('🔑', '請先設定免費 AI 金鑰', '填入 Groq 或 Gemini Key 即可一鍵自動聽打', 'border-violet-400/90');
        openAiSettingsModal();
      } else {
        if (statusEl) statusEl.textContent = `❌ 聽打失敗：${err?.message || '未知錯誤'}`;
        showGiantHud('❌', '自動聽打失敗', err?.message || '請確認網路或金鑰額度', 'border-rose-400/90');
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  safeOn('btnLoadSimulatedGptAudio', 'click', generateSimulatedGpt10SentenceLongAudio);

  safeOn('btnScrollToChunks', 'click', () => {
    document.getElementById('vadChunkListSection')?.scrollIntoView({ behavior: 'smooth' });
  });
  safeOn('btnScrollBackSliders', 'click', () => {
    document.getElementById('vadTopControlSection')?.scrollIntoView({ behavior: 'smooth' });
  });

  safeOn('inputLongAudioFile', 'change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    document.getElementById('vadAudioFileMeta').textContent = `解碼中：${file.name}...`;
    try {
      const arrBuf = await file.arrayBuffer();
      const ctx = getAudioContext();
      const audioBuf = await ctx.decodeAudioData(arrBuf);
      document.getElementById('vadAudioFileMeta').textContent = `${file.name} (${audioBuf.duration.toFixed(1)}s)`;
      document.getElementById('inputLongPackName').value = file.name.replace(/\.[^.]+$/, '');
      precomputeAudioEnvelope(audioBuf);
      refreshVadWorkbenchPreview();
    } catch (err) {
      document.getElementById('vadAudioFileMeta').textContent = `❌ 音檔解碼失敗：${err.message}`;
    }
  });

  safeOn('btnConfirmSaveSplitPack', 'click', async () => {
    const packName = document.getElementById('inputLongPackName')?.value || '長音檔切分教材';
    const normMode = document.getElementById('selectVadNormMode')?.value || 'rms';
    const newPack = buildSplitPackFromVad(packName, normMode);
    if (!newPack) {
      showGiantHud('⚠️', '尚未切出音檔段落', '請先載入長音檔或點擊模擬範例', 'border-amber-400/90');
      return;
    }

    await savePackToDB(newPack);
    state.packs.push(newPack);
    state.currentPack = newPack;
    state.currentIndex = 0;
    state.repeatCountCurrent = 1;
    state.pausedOffsetSec = 0;
    savePrefsSync();
    renderMainStage();
    modalImport?.classList.add('hidden');
    showGiantHud('💾', `已儲存 ${newPack.items.length} 句教材`, newPack.name, 'border-emerald-400/90');
  });

  // Tab B: ZIP / Multi-File Import
  safeOn('btnDownloadDemoZip', 'click', () => {
    generateAndDownloadDemoZip().catch((err) => {
      showGiantHud('❌', '測試 ZIP 產生失敗', err.message || '', 'border-rose-400/90');
    });
  });

  safeOn('inputZipOrMultiFiles', 'change', (e) => {
    const files = Array.from(e.target.files || []);
    const statusEl = document.getElementById('zipImportStatus');
    if (!files.length) {
      if (statusEl) statusEl.textContent = '尚未選擇檔案';
      return;
    }
    const zipFile = files.find(f => f.name.toLowerCase().endsWith('.zip'));
    if (zipFile) {
      const nameInput = document.getElementById('inputZipPackName');
      if (nameInput) nameInput.value = zipFile.name.replace(/\.zip$/i, '');
    }
    const previewNames = files.slice(0, 3).map(f => f.name).join(', ');
    if (statusEl) {
      statusEl.textContent = `已選取 ${files.length} 個檔案：${previewNames}${files.length > 3 ? ' ...' : ''}`;
    }
  });

  safeOn('btnConfirmZipImport', 'click', async () => {
    const fileInput = document.getElementById('inputZipOrMultiFiles');
    const statusEl = document.getElementById('zipImportStatus');
    const btnConfirm = document.getElementById('btnConfirmZipImport');
    const files = fileInput?.files;

    if (!files || !files.length) {
      showGiantHud('⚠️', '尚未選擇檔案', '請先選擇 ZIP 壓縮檔或多個音訊檔', 'border-amber-400/90');
      return;
    }

    if (btnConfirm) btnConfirm.disabled = true;
    try {
      const packName = document.getElementById('inputZipPackName')?.value || 'ZIP_匯入教材';
      const newPack = await importZipOrMultiFiles(files, packName, (msg) => {
        if (statusEl) statusEl.textContent = msg;
      });
      await savePackToDB(newPack);
      state.packs.push(newPack);
      state.currentPack = newPack;
      state.currentIndex = 0;
      state.repeatCountCurrent = 1;
      state.pausedOffsetSec = 0;
      savePrefsSync();
      renderMainStage();
      if (statusEl) statusEl.textContent = `✅ 已成功匯入 ${newPack.items.length} 句教材！`;
      if (fileInput) fileInput.value = '';
      modalImport?.classList.add('hidden');
      showGiantHud('📦', `已匯入 ${newPack.items.length} 句教材`, newPack.name, 'border-emerald-400/90');
    } catch (err) {
      if (statusEl) statusEl.textContent = `❌ 匯入失敗：${err.message}`;
      showGiantHud('❌', '匯入失敗', err.message || '請檢查檔案格式', 'border-rose-400/90');
    } finally {
      if (btnConfirm) btnConfirm.disabled = false;
    }
  });

  // Reset Built-in Demo Pack
  safeOn('btnResetBuiltinDemo', 'click', async () => {
    const def = createDefaultBuiltInPack();
    const existingIdx = state.packs.findIndex(p => p.id === def.id);
    if (existingIdx >= 0) state.packs[existingIdx] = def;
    else state.packs.unshift(def);
    await savePackToDB(def);
    state.currentPack = def;
    state.currentIndex = 0;
    state.repeatCountCurrent = 1;
    state.pausedOffsetSec = 0;
    savePrefsSync();
    renderMainStage();
    modalImport?.classList.add('hidden');
    showGiantHud('🔄', '已重置內建 20 句範例', def.name, 'border-sky-400/90');
  });
}

function bootstrapApp() {
  initApplication();
  bindAllEvents();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootstrapApp);
} else {
  bootstrapApp();
}