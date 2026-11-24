// Layer 3: Application Entry Point, UI Rendering, Modal Controllers & Event Bindings

import {
  APP_VERSION,
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
  showPackSaveFailedHud,
  copyTextSynchronously,
  keyEventLogs,
  logKeyEvent,
  setKeyEventLogListener,
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
  drawVadWaveformCanvas,
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
  actionCopySentenceWithAiPrompt,
  transcribeLongAudioWithAi
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
// KEY HINTS (FOLLOW THE CURRENT KEYMAP)
// ==========================================
function formatKeyCodeLabel(code) {
  const c = String(code || '');
  const named = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', PageUp: 'PgUp', PageDown: 'PgDn', ' ': 'Space' };
  if (named[c]) return named[c];
  const letterOrDigit = c.match(/^(?:Key|Digit)([A-Z0-9])$/);
  return letterOrDigit ? letterOrDigit[1] : c;
}

// The giant buttons are narrow: show the first key, plus the second one only when both stay short
function formatKeyHintText(action) {
  const labels = (state.keymap[action]?.codes || []).map(formatKeyCodeLabel);
  if (labels.length === 0) return '未綁定';
  const both = labels.slice(0, 2).join(' / ');
  return labels.length > 1 && both.length <= 8 ? both : labels[0];
}

function refreshKeyHints() {
  const hintIds = { prev: 'keyHintPrev', restart: 'keyHintRestart', play: 'keyHintPlay', next: 'keyHintNext', speed: 'keyHintSpeed' };
  Object.entries(hintIds).forEach(([action, id]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const codes = state.keymap[action]?.codes || [];
    el.textContent = action === 'play' && codes.length > 0
      ? `${formatKeyCodeLabel(codes[0])}(長按調速)`
      : formatKeyHintText(action);
  });

  const titledButtons = {
    ai: ['btnAiExplain', '一鍵翻譯本句並由 AI 簡答核心單字與句型'],
    copy: ['btnCopySentence', '點擊複製本句乾淨英文並自動原地暫停'],
    merge: ['btnMergeNextSentence', '將本句與下一句音檔無縫合併']
  };
  Object.entries(titledButtons).forEach(([action, [id, text]]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const labels = (state.keymap[action]?.codes || []).map(formatKeyCodeLabel);
    el.title = labels.length > 0 ? `${text} (快捷鍵 ${labels.join(' / ')})` : text;
  });
}

// ==========================================
// DIAGNOSTIC LOG VIEWER
// ==========================================
function renderDiagLogList() {
  const box = document.getElementById('diagLogContainer');
  if (!box) return;
  const logs = Array.isArray(window.__diagLogs) ? window.__diagLogs : [];
  box.innerHTML = '';

  const addHeading = (title, hint) => {
    const head = document.createElement('div');
    head.className = 'font-sans pt-1';
    const titleEl = document.createElement('div');
    titleEl.className = 'text-xs font-black text-white';
    titleEl.textContent = title;
    const hintEl = document.createElement('div');
    hintEl.className = 'text-[11px] text-slate-400';
    hintEl.textContent = hint;
    head.append(titleEl, hintEl);
    box.appendChild(head);
  };
  const addLine = (text, tone) => {
    const line = document.createElement('div');
    line.className = `px-2 py-1.5 rounded-lg bg-slate-950 border break-words ${tone}`;
    line.textContent = text;
    box.appendChild(line);
  };
  const addEmpty = (text) => {
    const empty = document.createElement('div');
    empty.className = 'text-slate-500 font-sans py-3 text-center';
    empty.textContent = text;
    box.appendChild(empty);
  };

  addHeading(
    `🎮 按鍵 / 遙控器事件（${keyEventLogs.length}）`,
    '開著這個視窗按遙控器，收到的事件會即時出現在這裡。按了卻什麼都沒出現，代表遙控器送的是網頁收不到的訊號（例如音量鍵）。'
  );
  if (keyEventLogs.length === 0) {
    addEmpty('還沒有收到任何按鍵、媒體鍵或觸控事件。');
  } else {
    keyEventLogs.forEach((entry) => addLine(entry, 'text-sky-200 border-sky-500/30'));
  }

  addHeading(`⚠️ 錯誤與自動修復（${logs.length}）`, '播放中斷、AI 呼叫失敗、教材寫入失敗等。');
  if (logs.length === 0) {
    addEmpty('沒有紀錄，代表這次開啟以來沒有發生錯誤或自動修復。');
  } else {
    logs.forEach((entry) => {
      const tone = entry.includes('[ERROR]')
        ? 'text-rose-300 border-rose-500/30'
        : entry.includes('[WARN]')
          ? 'text-amber-200 border-amber-500/30'
          : 'text-slate-300 border-slate-800';
      addLine(entry, tone);
    });
  }
}

function buildDiagReportText() {
  const logs = Array.isArray(window.__diagLogs) ? window.__diagLogs : [];
  const pack = state.currentPack;
  const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches || navigator.standalone === true;
  return [
    `車用盲操英文跟讀播放器 ${APP_VERSION} 診斷紀錄`,
    `時間：${new Date().toLocaleString()}`,
    `瀏覽器：${navigator.userAgent}`,
    `開啟方式：${standalone ? '主畫面 App (standalone)' : '瀏覽器分頁'}`,
    `AI 引擎：${state.aiConfig?.provider || '未設定'}`,
    `目前教材：${pack ? `${pack.items?.length || 0} 句，第 ${state.currentIndex + 1} 句` : '無'}`,
    '',
    `按鍵 / 遙控器事件（新到舊，共 ${keyEventLogs.length} 筆）：`,
    ...(keyEventLogs.length > 0 ? keyEventLogs : ['（無）']),
    '',
    `錯誤與自動修復（新到舊，共 ${logs.length} 筆）：`,
    ...(logs.length > 0 ? logs : ['（無）'])
  ].join('\n');
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
  refreshKeyHints();

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
      state.undoMergeSnapshot = null;
      state.currentPack = found;
      state.currentIndex = Number(state.packProgressMap[found.id]) || 0;
      state.repeatCountCurrent = 1;
      state.pausedOffsetSec = 0;
      savePrefsSync();
      renderMainStage();
    }
  });

  // Deleting is irreversible, so it takes two taps: the first arms the button, the second (within 4s) deletes
  let deleteArmedPackId = null;
  let deleteArmTimerId = null;
  const disarmDeleteButton = () => {
    deleteArmedPackId = null;
    if (deleteArmTimerId) {
      clearTimeout(deleteArmTimerId);
      deleteArmTimerId = null;
    }
    document.getElementById('btnDeletePack')?.classList.remove('btn-delete-armed');
  };

  safeOn('btnDeletePack', 'click', async () => {
    if (!state.currentPack || state.currentPack.id === 'default_pack') {
      showGiantHud('ℹ️', '預設教材無法刪除', '可匯入自己的長音檔或 ZIP 新增課程', 'border-sky-400/90');
      return;
    }
    const delId = state.currentPack.id;
    if (deleteArmedPackId !== delId) {
      disarmDeleteButton();
      deleteArmedPackId = delId;
      document.getElementById('btnDeletePack')?.classList.add('btn-delete-armed');
      deleteArmTimerId = setTimeout(disarmDeleteButton, 4000);
      showGiantHud('🗑️', '再按一次確認刪除', `${state.currentPack.name}（刪除後無法復原）`, 'border-rose-400/90');
      return;
    }
    disarmDeleteButton();
    pausePlaybackInPlace('刪除教材');
    await deletePackFromDB(delId);
    state.packs = state.packs.filter(p => p.id !== delId);
    delete state.packProgressMap[delId];
    state.undoMergeSnapshot = null;
    state.currentPack = state.packs[0];
    state.currentIndex = Number(state.packProgressMap[state.currentPack.id]) || 0;
    state.repeatCountCurrent = 1;
    state.pausedOffsetSec = 0;
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

  // Modal: Diagnostic log viewer (opened from the version / changelog modal)
  const modalDiag = document.getElementById('modalDiag');
  const openDiagModal = () => {
    document.getElementById('modalChangelog')?.classList.add('hidden');
    document.getElementById('modalKeymap')?.classList.add('hidden');
    state.listeningKeyAction = null;
    renderDiagLogList();
    modalDiag?.classList.remove('hidden');
    // Same focus state as the main screen after tapping a control, so a remote behaves here as it does there
    focusBtKeyCatcher();
  };
  safeOn('btnOpenDiagLog', 'click', openDiagModal);
  safeOn('btnOpenDiagFromKeymap', 'click', openDiagModal);
  safeOn('btnCloseDiagLog', 'click', () => {
    modalDiag?.classList.add('hidden');
    focusBtKeyCatcher();
  });
  safeOn('btnClearDiagLog', 'click', () => {
    if (Array.isArray(window.__diagLogs)) window.__diagLogs.length = 0;
    keyEventLogs.length = 0;
    renderDiagLogList();
    focusBtKeyCatcher();
  });
  // Live view: new events show up while the viewer is open
  setKeyEventLogListener(() => {
    if (modalDiag && !modalDiag.classList.contains('hidden')) renderDiagLogList();
  });
  let diagCopyResetTimerId = null;
  safeOn('btnCopyDiagLog', 'click', () => {
    copyTextSynchronously(buildDiagReportText());
    // The giant HUD sits behind modals, so confirm on the button itself
    const btn = document.getElementById('btnCopyDiagLog');
    if (!btn) return;
    btn.textContent = '✓ 已複製';
    if (diagCopyResetTimerId) clearTimeout(diagCopyResetTimerId);
    diagCopyResetTimerId = setTimeout(() => {
      btn.textContent = '📋 複製全部';
    }, 1500);
  });

  // Modal: Keymap (Bluetooth Page Turner / Keyboard) + iOS PWA Hidden Input Catcher
  const modalKeymap = document.getElementById('modalKeymap');
  const btCatcher = document.getElementById('btKeyCatcher');
  let keymapNotice = '';

  const focusBtKeyCatcher = () => {
    if (!btCatcher) return;
    try {
      btCatcher.value = '';
      btCatcher.focus({ preventScroll: true });
    } catch (e) {
      try { btCatcher.focus(); } catch (err) {}
    }
  };

  const blurBtKeyCatcher = () => {
    if (btCatcher && document.activeElement === btCatcher) {
      try { btCatcher.blur(); } catch (e) {}
    }
  };

  const normalizeKeyCode = (rawCode, rawKey) => {
    if (rawCode && rawCode !== 'Unidentified' && rawCode !== 'Process') {
      return rawCode;
    }
    const k = String(rawKey || '');
    if (!k || k === 'Unidentified' || k === 'Process' || k === 'Dead') return '';
    if (k === ' ') return 'Space';
    if (/^[a-zA-Z]$/.test(k)) return `Key${k.toUpperCase()}`;
    if (/^[0-9]$/.test(k)) return `Digit${k}`;
    return k;
  };

  const renderKeymapRows = () => {
    const box = document.getElementById('keymapListContainer');
    if (!box) return;
    box.innerHTML = '';
    if (keymapNotice) {
      const note = document.createElement('div');
      note.className = 'p-2.5 rounded-xl bg-amber-950/40 border border-amber-500/40 text-[11px] text-amber-200 font-bold';
      note.textContent = keymapNotice;
      box.appendChild(note);
    }
    Object.entries(state.keymap).forEach(([k, info]) => {
      const codes = info.codes || [];
      const isListening = state.listeningKeyAction === k;
      const chipsHtml = codes.length > 0
        ? codes.map((code, i) => `<button type="button" data-remove-idx="${i}" title="移除這個按鍵" class="px-1.5 py-0.5 rounded-lg bg-slate-800 hover:bg-rose-950 border border-slate-700 hover:border-rose-500/60 font-mono text-[11px] text-amber-300 hover:text-rose-200 transition">${escapeHtml(code)} <span class="text-slate-500">✕</span></button>`).join('')
        : '<span class="text-[11px] text-slate-500">尚未綁定按鍵</span>';
      const row = document.createElement('div');
      row.className = `p-3 rounded-2xl bg-slate-950 border ${isListening ? 'border-sky-400' : 'border-slate-800'} flex items-center justify-between gap-2`;
      row.innerHTML = `
        <div class="min-w-0">
          <div class="font-bold text-white">${escapeHtml(info.label)}</div>
          <div class="flex flex-wrap gap-1 mt-1">${chipsHtml}</div>
        </div>
        <button type="button" data-k="${k}" class="px-3 py-1.5 rounded-xl ${isListening ? 'bg-sky-500 text-slate-950' : 'bg-slate-800 hover:bg-sky-500 hover:text-slate-950'} font-bold text-xs transition shrink-0">
          ${isListening ? '請按按鍵…(點此取消)' : '學習按鍵'}
        </button>
      `;
      row.querySelector('[data-k]').addEventListener('click', () => {
        // Tapping the row that is already listening cancels it
        state.listeningKeyAction = isListening ? null : k;
        keymapNotice = '';
        renderKeymapRows();
        // Must focus synchronously inside user click so iOS PWA grants hardware keyboard focus
        focusBtKeyCatcher();
      });
      row.querySelectorAll('[data-remove-idx]').forEach((chip) => {
        chip.addEventListener('click', () => {
          const removed = codes.splice(Number(chip.dataset.removeIdx), 1)[0];
          state.listeningKeyAction = null;
          keymapNotice = `已移除「${info.label}」的按鍵 ${removed}`;
          saveKeymapSync(state.keymap);
          refreshKeyHints();
          renderKeymapRows();
          // The tapped chip is gone after the re-render; hand hardware-key focus back to the catcher
          focusBtKeyCatcher();
        });
      });
      box.appendChild(row);
    });
  };

  safeOn('btnOpenKeymapModal', 'click', () => {
    state.listeningKeyAction = null;
    keymapNotice = '';
    renderKeymapRows();
    modalKeymap?.classList.remove('hidden');
    focusBtKeyCatcher();
  });
  safeOn('btnCloseKeymapModal', 'click', () => {
    state.listeningKeyAction = null;
    modalKeymap?.classList.add('hidden');
    focusBtKeyCatcher();
  });
  safeOn('btnDoneKeymap', 'click', () => {
    state.listeningKeyAction = null;
    modalKeymap?.classList.add('hidden');
    focusBtKeyCatcher();
  });
  safeOn('btnResetDefaultKeys', 'click', () => {
    state.listeningKeyAction = null;
    keymapNotice = '已恢復預設按鍵';
    saveKeymapSync(cloneDefaultKeymap());
    refreshKeyHints();
    renderKeymapRows();
    focusBtKeyCatcher();
  });

  // Global Keyboard / Bluetooth Page Turner Interceptor (Desktop + iOS PWA)
  const KEY_ACTION_ORDER = ['prev', 'restart', 'play', 'next', 'speed', 'loop', 'merge', 'copy', 'ai'];
  const keyActionHandlers = {
    prev: actionPrevSentence,
    restart: actionRestartCurrentSentence,
    next: actionNextSentence,
    speed: actionCycleSpeed,
    loop: actionToggleInfiniteLoop,
    merge: actionMergeWithNextSentence,
    copy: triggerCopyCurrentSentence,
    ai: () => actionAiExplainCurrentSentence(false)
  };

  let heldPlayCode = null;
  let heldPlayTimerId = null;
  let heldPlayLongPressFired = false;
  let lastKeydownHandledCode = '';
  let lastKeydownHandledAt = 0;

  const clearHeldPlayKey = () => {
    if (heldPlayTimerId) {
      clearTimeout(heldPlayTimerId);
      heldPlayTimerId = null;
    }
    heldPlayCode = null;
    heldPlayLongPressFired = false;
  };

  const learnBoundKey = (code) => {
    const act = state.listeningKeyAction;
    const target = state.keymap[act];
    if (!act || !target) return;
    // One key drives one action: binding it here takes it away from wherever it was bound before,
    // otherwise the action later in the list would silently never fire
    const takenFrom = [];
    Object.entries(state.keymap).forEach(([other, info]) => {
      if (other === act || !Array.isArray(info.codes)) return;
      const at = info.codes.indexOf(code);
      if (at >= 0) {
        info.codes.splice(at, 1);
        takenFrom.push(info.label);
      }
    });
    // Newest binding goes first so the on-screen hint shows the key the user actually uses
    target.codes = [code, ...(target.codes || []).filter((c) => c !== code)];
    keymapNotice = takenFrom.length > 0
      ? `按鍵 ${code} 原本綁在「${takenFrom.join('、')}」，已改綁到「${target.label}」`
      : `已將按鍵 ${code} 綁定到「${target.label}」`;
    state.listeningKeyAction = null;
    clearHeldPlayKey();
    saveKeymapSync(state.keymap);
    refreshKeyHints();
    renderKeymapRows();
    showGiantHud('⌨️', `已綁定 ${code}`, target.label, 'border-emerald-400/90');
  };

  // --- Input event trace (shown in the diagnostics viewer) ---
  // Typing in a real text field (API keys, subtitles) is never traced: those keystrokes are private.
  const isTypingInRealField = () => {
    const el = document.activeElement;
    return el?.id !== 'btKeyCatcher' && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tagName);
  };
  const describeFocus = () => {
    const el = document.activeElement;
    if (!el || el === document.body) return '頁面';
    if (el.id === 'btKeyCatcher') return '隱藏輸入框';
    return el.id ? `${el.tagName.toLowerCase()}#${el.id}` : el.tagName.toLowerCase();
  };
  const describeKeyEvent = (e) =>
    `${e.type} code="${e.code || ''}" key="${e.key === ' ' ? '(空白)' : (e.key || '')}" keyCode=${e.keyCode || 0} 焦點=${describeFocus()}`;

  window.addEventListener('keydown', (e) => {
    const activeEl = document.activeElement;
    const isCatcher = activeEl?.id === 'btKeyCatcher';
    if (!isCatcher && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeEl?.tagName)) return;

    // A held key auto-repeats; trace only the first keydown of each press
    const trace = (result) => {
      if (!e.repeat) logKeyEvent(`${describeKeyEvent(e)} → ${result}`);
    };

    const code = normalizeKeyCode(e.code, e.key);
    if (!code) {
      trace('無法辨識的按鍵，略過');
      return;
    }

    if (state.listeningKeyAction) {
      e.preventDefault();
      lastKeydownHandledCode = code;
      lastKeydownHandledAt = Date.now();
      if (isCatcher && btCatcher) btCatcher.value = '';
      if (e.repeat) return;
      trace(`學習綁定到「${state.keymap[state.listeningKeyAction]?.label || ''}」`);
      learnBoundKey(code);
      return;
    }

    const matchedAction = KEY_ACTION_ORDER.find((act) => (state.keymap[act]?.codes || []).includes(code));
    if (!matchedAction) {
      trace(`沒有綁定任何動作（可到「按鍵」視窗把 ${code} 學起來）`);
      return;
    }
    e.preventDefault();
    lastKeydownHandledCode = code;
    lastKeydownHandledAt = Date.now();
    if (isCatcher && btCatcher) btCatcher.value = '';

    // A held key auto-repeats keydown; one physical press must fire its action only once
    if (e.repeat) return;

    if (matchedAction === 'play') {
      trace('播放鍵按下（放開時才切換播放；按住 0.5 秒改為切換語速）');
      // Same as the on-screen button: a short press toggles on release, holding 0.5s cycles speed instead
      clearHeldPlayKey();
      heldPlayCode = code;
      heldPlayTimerId = setTimeout(() => {
        heldPlayTimerId = null;
        heldPlayLongPressFired = true;
        logKeyEvent('播放鍵已按住 0.5 秒 → 切換語速（如果你只是短按，代表這個遙控器沒有送出放開事件）');
        actionCycleSpeed();
      }, 500);
      return;
    }
    trace(`執行動作：${state.keymap[matchedAction]?.label || matchedAction}`);
    keyActionHandlers[matchedAction]();
  });

  window.addEventListener('keyup', (e) => {
    const code = normalizeKeyCode(e.code, e.key);
    if (heldPlayCode === null || code !== heldPlayCode) {
      if (!isTypingInRealField()) logKeyEvent(`${describeKeyEvent(e)} → 放開（無動作）`);
      return;
    }
    // Also stops Space/Enter from additionally clicking whichever button currently has focus
    e.preventDefault();
    const wasLongPress = heldPlayLongPressFired;
    clearHeldPlayKey();
    logKeyEvent(`${describeKeyEvent(e)} → ${wasLongPress ? '播放鍵放開（長按已切換過語速）' : '播放鍵放開，切換播放 / 暫停'}`);
    if (!wasLongPress) actionTogglePlayPause();
  });

  // Many phone remotes are not keyboards at all: they fake a finger tap or swipe at a fixed screen position.
  // Tracing pointer presses makes that visible (taps inside the viewer itself are left out).
  window.addEventListener('pointerdown', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('#modalDiag')) return;
    const owner = target?.closest('[id]');
    logKeyEvent(`pointerdown type=${e.pointerType || '?'} 位置=(${Math.round(e.clientX)}, ${Math.round(e.clientY)}) 目標=${owner ? `#${owner.id}` : (target?.tagName.toLowerCase() || '?')}`);
  }, true);

  // If the window loses focus mid-press the keyup never arrives; drop the pending press
  window.addEventListener('blur', clearHeldPlayKey);

  // Fallback for iOS PWA where Bluetooth HID letters (a, b, c) fire `input` without a usable `keydown`
  if (btCatcher) {
    btCatcher.addEventListener('input', () => {
      const val = btCatcher.value;
      btCatcher.value = '';
      if (!val) return;
      const ch = val.slice(-1);
      const code = normalizeKeyCode('', ch);
      const trace = (result) => logKeyEvent(`隱藏輸入框 input 收到 "${ch === ' ' ? '(空白)' : ch}"（視為 ${code || '無法辨識'}） → ${result}`);
      if (!code) {
        trace('略過');
        return;
      }
      if (code === lastKeydownHandledCode && Date.now() - lastKeydownHandledAt < 120) {
        trace('略過：同一下按鍵已由 keydown 處理');
        return;
      }
      if (state.listeningKeyAction) {
        trace(`學習綁定到「${state.keymap[state.listeningKeyAction]?.label || ''}」`);
        learnBoundKey(code);
        return;
      }
      const matchedAction = KEY_ACTION_ORDER.find((act) => (state.keymap[act]?.codes || []).includes(code));
      if (!matchedAction) {
        trace('沒有綁定任何動作');
        return;
      }
      trace(`執行動作：${state.keymap[matchedAction]?.label || matchedAction}`);
      if (matchedAction === 'play') {
        actionTogglePlayPause();
      } else {
        keyActionHandlers[matchedAction]();
      }
    });
  }

  // Keep Bluetooth HID focus active on iOS PWA after tapping main playback controls
  ['btnControlPrev', 'btnControlRestart', 'btnControlPlay', 'btnControlNext', 'btnControlSpeed'].forEach((id) => {
    safeOn(id, 'click', focusBtKeyCatcher);
  });

  // Release hidden catcher when opening modals that contain real text inputs
  safeOn('btnOpenImportModal', 'click', blurBtKeyCatcher);
  safeOn('btnOpenAiSettings', 'click', blurBtKeyCatcher);
  safeOn('btnDrawerOpenAiKey', 'click', blurBtKeyCatcher);

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

      const metaParts = [
        result.trimmedHeadSec > 0.2 ? `已裁切開頭 ${result.trimmedHeadSec.toFixed(1)}s 靜音` : '無開頭靜音',
        `分 ${result.chunkCount || 1} 段`,
        result.resamplerUsed || '16kHz'
      ];
      const metaSummary = metaParts.join('｜');

      if (result.segments && result.segments.length > 0) {
        state.vadSegments = result.segments;
        renderVadChunkListUI();
        drawVadWaveformCanvas();
        if (statusEl) {
          statusEl.textContent = `✅ ${result.modelUsed} 聽打完成：共 ${result.lines.length} 句（${metaSummary}）`;
        }
        showGiantHud('🎙️', `聽打完成 ${result.lines.length} 句`, `${result.modelUsed}｜已套用精準時間軸`, 'border-emerald-400/90');
      } else {
        autoFindMatchingDbThreshold();
        if (statusEl) {
          statusEl.textContent = `✅ ${result.modelUsed} 雙語聽打完成：共 ${result.lines.length} 句（${metaSummary}）`;
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

    const saved = await savePackToDB(newPack);
    state.packs.push(newPack);
    state.undoMergeSnapshot = null;
    state.currentPack = newPack;
    state.currentIndex = 0;
    state.repeatCountCurrent = 1;
    state.pausedOffsetSec = 0;
    savePrefsSync();
    renderMainStage();
    modalImport?.classList.add('hidden');
    if (saved) {
      showGiantHud('💾', `已儲存 ${newPack.items.length} 句教材`, newPack.name, 'border-emerald-400/90');
    } else {
      showPackSaveFailedHud();
    }
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
      const saved = await savePackToDB(newPack);
      state.packs.push(newPack);
      state.undoMergeSnapshot = null;
      state.currentPack = newPack;
      state.currentIndex = 0;
      state.repeatCountCurrent = 1;
      state.pausedOffsetSec = 0;
      savePrefsSync();
      renderMainStage();
      if (statusEl) {
        statusEl.textContent = saved
          ? `✅ 已成功匯入 ${newPack.items.length} 句教材！`
          : `⚠️ 已載入 ${newPack.items.length} 句，但未能寫入裝置（重新整理後會遺失）`;
      }
      if (fileInput) fileInput.value = '';
      modalImport?.classList.add('hidden');
      if (saved) {
        showGiantHud('📦', `已匯入 ${newPack.items.length} 句教材`, newPack.name, 'border-emerald-400/90');
      } else {
        showPackSaveFailedHud();
      }
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
    state.undoMergeSnapshot = null;
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

// EOF: js/app.js