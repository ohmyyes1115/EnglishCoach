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
  MAX_KEY_CLICKS,
  makeKeyBinding,
  parseKeyBinding,
  storageProtection,
  requestPersistentStorage,
  refreshStorageUsage,
  describeStorageProtection,
  formatBytes,
  savePrefsSync,
  loadPrefsSync,
  loadAiConfigSync,
  saveAiConfigSync,
  loadKeymapSync,
  saveKeymapSync,
  safeStorage,
  PACK_TRANSLATE_ZH_SOURCE_PREFIX
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
  importZipOrMultiFiles,
  buildPackBackupZip
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
  triggerCopyCurrentSentence,
  describeScreenWakeLock,
  setScreenWakeLockHold
} from './player-engine.js';

import {
  listPackTranslationEngines,
  translatePack,
  describeTranslateError,
  describeUsage,
  cleanSentenceText,
  rememberPreferredEngine,
  findPreferredEngine,
  translateTranscriptLines
} from './pack-translate.js';

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

import {
  initGptLiveModule,
  openGptLiveModal,
  openGptLiveAndExplainCurrentSentence
} from './gpt-live.js';

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

  const dur = Number(item.durationSec) || 2.8;
  document.getElementById('timeTotal').textContent = formatTimeSec(dur);

  const demoBtn = document.getElementById('btnDemoVoiceMode');
  if (demoBtn) {
    demoBtn.classList.toggle('hidden', !state.currentPack.isDemoTTS);
    demoBtn.textContent = state.demoVoiceMode === 'tts_and_pad'
      ? '🔊 範例人聲：語音+墊音'
      : '🔊 範例人聲：僅TTS語音';
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
// Short form for the narrow on-screen hints: "P", "P×2" (double click), "P×3" (triple click)
function formatKeyCodeLabel(binding) {
  const { code: c, clicks } = parseKeyBinding(binding);
  const suffix = clicks > 1 ? `×${clicks}` : '';
  const named = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', PageUp: 'PgUp', PageDown: 'PgDn', ' ': 'Space' };
  if (named[c]) return named[c] + suffix;
  const letterOrDigit = c.match(/^(?:Key|Digit)([A-Z0-9])$/);
  return (letterOrDigit ? letterOrDigit[1] : c) + suffix;
}

// Long form for the keymap window and the diagnostics trace: "KeyP", "KeyP 雙擊", "KeyP 三擊"
function describeKeyBinding(binding) {
  const { code, clicks } = parseKeyBinding(binding);
  return clicks === 2 ? `${code} 雙擊` : clicks === 3 ? `${code} 三擊` : code;
}

// Highest click count bound to this key across all actions: 0 = key unused, 1 = single click only,
// 2 or 3 = the key has a multi-click binding, so each press must wait to see whether another follows
function maxClicksBoundToKey(code) {
  let max = 0;
  Object.values(state.keymap).forEach((info) => {
    (info.codes || []).forEach((binding) => {
      const parsed = parseKeyBinding(binding);
      if (parsed.code === code && parsed.clicks > max) max = parsed.clicks;
    });
  });
  return max;
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
    // Holding the play key for speed only works on a key without multi-click bindings
    const playKeySupportsHold = action === 'play' && codes.length > 0 && maxClicksBoundToKey(parseKeyBinding(codes[0]).code) === 1;
    el.textContent = playKeySupportsHold
      ? `${formatKeyCodeLabel(codes[0])}(長按調速)`
      : formatKeyHintText(action);
  });

  const titledButtons = {
    ai: ['btnAiExplain', '一鍵翻譯本句並由 AI 簡答核心單字與句型'],
    copy: ['btnCopySentence', '點擊複製本句乾淨英文並自動原地暫停']
  };
  Object.entries(titledButtons).forEach(([action, [id, text]]) => {
    const el = document.getElementById(id);
    if (!el) return;
    const labels = (state.keymap[action]?.codes || []).map(formatKeyCodeLabel);
    el.title = labels.length > 0 ? `${text} (快捷鍵 ${labels.join(' / ')})` : text;
  });
}

// ==========================================
// STORAGE PROTECTION STATUS
// ==========================================
function renderStorageStatusLine() {
  const el = document.getElementById('storageStatusLine');
  if (!el) return;
  const tone = storageProtection.status === 'granted'
    ? 'border-emerald-500/40 text-emerald-300'
    : storageProtection.status === 'unknown'
      ? 'border-slate-800 text-slate-400'
      : 'border-amber-500/40 text-amber-200';
  el.className = `px-3 py-2 rounded-xl bg-slate-950/90 border text-[11px] font-bold ${tone}`;
  el.textContent = describeStorageProtection();
}

// Asks the browser not to wipe the saved packs. Safe to call repeatedly: browsers that refused at
// startup often agree later, once the site has been used more or was added to the home screen.
async function ensureStorageProtection() {
  const before = storageProtection.status;
  const status = await requestPersistentStorage();
  if (status !== before && status !== 'granted' && typeof window.logDiag === 'function') {
    window.logDiag('WARN', status === 'denied'
      ? '瀏覽器未同意儲存保護：裝置空間不足時教材可能被自動清除，建議匯出備份'
      : '這個瀏覽器不支援儲存保護，建議匯出備份');
  }
  renderStorageStatusLine();
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
    `儲存：${describeStorageProtection()}`,
    `螢幕恆亮：${describeScreenWakeLock()}`,
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

  // Not awaited: the answer only affects the status line and the diagnostics report
  ensureStorageProtection();
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
      setReadyBackup(null);
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
    state.currentPack = state.packs[0];
    state.currentIndex = Number(state.packProgressMap[state.currentPack.id]) || 0;
    state.repeatCountCurrent = 1;
    state.pausedOffsetSec = 0;
    savePrefsSync();
    renderMainStage();
    showGiantHud('🗑️', '已刪除教材包', state.currentPack.name);
  });

  // Export the current pack as a backup ZIP.
  // Desktop and Android save it through a normal download. iOS has no reliable download for a home-screen
  // app, so there the file goes to the system share sheet ("Save to Files", AirDrop). The share sheet may
  // only be opened straight from a tap, and packing a large pack takes longer than iOS allows, so the
  // packed file is kept and the button turns green: the next tap opens the share sheet at once.
  const btnExportPack = document.getElementById('btnExportPack');
  let readyBackup = null;
  let readyBackupTimerId = null;
  let isBuildingBackup = false;

  const setReadyBackup = (backup) => {
    readyBackup = backup;
    if (readyBackupTimerId) clearTimeout(readyBackupTimerId);
    // The packed copy goes stale once notes change, and holds the whole pack in memory: drop it after 2 minutes
    readyBackupTimerId = backup ? setTimeout(() => setReadyBackup(null), 120000) : null;
    btnExportPack?.classList.toggle('btn-export-ready', Boolean(backup));
  };

  const isAppleTouchDevice = () =>
    /iPad|iPhone|iPod/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const canShareBackupFile = (file) => {
    try {
      return typeof File !== 'undefined' && file instanceof File
        && typeof navigator.share === 'function' && typeof navigator.canShare === 'function'
        && navigator.canShare({ files: [file] });
    } catch (e) {
      return false;
    }
  };

  const downloadBackupViaLink = (backup) => {
    const url = URL.createObjectURL(backup.file);
    const a = document.createElement('a');
    a.href = url;
    a.download = backup.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  // Must start synchronously inside the tap handler: navigator.share() is refused otherwise
  const deliverBackup = async (backup) => {
    const sizeText = formatBytes(backup.sizeBytes);
    if (isAppleTouchDevice() && canShareBackupFile(backup.file)) {
      try {
        await navigator.share({ files: [backup.file] });
        setReadyBackup(null);
        showGiantHud('📦', '備份已匯出', `${backup.fileName}（${sizeText}）`, 'border-emerald-400/90', 2500);
        return;
      } catch (err) {
        if (err?.name === 'AbortError') {
          setReadyBackup(backup);
          showGiantHud('📦', '尚未儲存備份', '已關閉分享選單；再按一次綠色匯出鍵可重新選擇', 'border-amber-400/90', 3000);
          return;
        }
        if (err?.name === 'NotAllowedError') {
          setReadyBackup(backup);
          showGiantHud('📦', '備份已打包好', `再按一次綠色匯出鍵，選「儲存到檔案」（${sizeText}）`, 'border-emerald-400/90', 5000);
          return;
        }
        if (typeof window.logDiag === 'function') {
          window.logDiag('WARN', `分享選單無法開啟 (${err?.name || 'Error'})，改用下載連結匯出備份`);
        }
      }
    }
    downloadBackupViaLink(backup);
    setReadyBackup(null);
    showGiantHud('⬇️', '已匯出備份 ZIP', `${backup.fileName}（${sizeText}）`, 'border-emerald-400/90', 2500);
  };

  safeOn('btnExportPack', 'click', async () => {
    // Keep hardware-key focus on the hidden catcher (iOS only grants it inside a tap)
    focusBtKeyCatcher();
    const pack = state.currentPack;
    if (!pack || isBuildingBackup) return;
    if (readyBackup && readyBackup.packId === pack.id) {
      await deliverBackup(readyBackup);
      return;
    }
    setReadyBackup(null);
    isBuildingBackup = true;
    if (btnExportPack) btnExportPack.disabled = true;
    showGiantHud('📦', '正在打包備份…', pack.name, 'border-sky-400/90', 60000);
    try {
      const built = await buildPackBackupZip(pack, (percent) => {
        const sub = document.getElementById('giantHudSub');
        if (sub) sub.textContent = `${pack.name}（${percent}%）`;
      });
      if (built.skippedAudioCount > 0 && typeof window.logDiag === 'function') {
        window.logDiag('WARN', `匯出備份時有 ${built.skippedAudioCount} 句的音檔格式無法寫入 ZIP，已略過音檔（文字仍保留）`);
      }
      await deliverBackup({ packId: pack.id, file: built.file, fileName: built.fileName, sizeBytes: built.sizeBytes });
    } catch (err) {
      if (typeof window.logDiag === 'function') {
        window.logDiag('ERROR', `匯出備份失敗：${err?.message || err}`);
      }
      showGiantHud('❌', '匯出備份失敗', err?.message || '請稍後再試', 'border-rose-400/90', 4000);
    } finally {
      isBuildingBackup = false;
      if (btnExportPack) btnExportPack.disabled = false;
    }
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

  // Modal: Whole-pack Chinese translation
  const modalPackTranslate = document.getElementById('modalPackTranslate');
  let packTranslateEngines = [];
  let packTranslateRunning = false;
  let packTranslateCancelRequested = false;
  let packTranslateOpenToken = 0;

  const packTranslateEl = (id) => document.getElementById(id);
  const selectedPackTranslateEngine = () => {
    const id = document.querySelector('input[name="packTranslateEngine"]:checked')?.value;
    return packTranslateEngines.find((e) => e.id === id) || null;
  };
  const countSentencesWithoutZh = (pack) =>
    (pack?.items || []).filter((it) => cleanSentenceText(it.en) && !(it.zh && it.zh.trim())).length;

  const refreshPackTranslateControls = () => {
    const pack = state.currentPack;
    const total = pack?.items?.length || 0;
    const missing = countSentencesWithoutZh(pack);
    const summary = packTranslateEl('packTranslateSummary');
    if (summary) summary.textContent = pack ? `${pack.name}｜共 ${total} 句，其中 ${missing} 句還沒有中譯` : '';
    const missingLabel = packTranslateEl('packTranslateScopeMissingLabel');
    const allLabel = packTranslateEl('packTranslateScopeAllLabel');
    if (missingLabel) missingLabel.textContent = `只翻譯還沒有中譯的 ${missing} 句`;
    if (allLabel) allLabel.textContent = `全部 ${total} 句重新翻譯（覆蓋現有中譯）`;
    const missingRadio = document.querySelector('input[name="packTranslateScope"][value="missing"]');
    const allRadio = document.querySelector('input[name="packTranslateScope"][value="all"]');
    if (missingRadio && allRadio) {
      missingRadio.disabled = packTranslateRunning || missing === 0;
      allRadio.disabled = packTranslateRunning;
      if (missing === 0 && missingRadio.checked) allRadio.checked = true;
    }
    document.querySelectorAll('input[name="packTranslateEngine"]').forEach((el) => { el.disabled = packTranslateRunning; });
    const startBtn = packTranslateEl('btnPackTranslateStart');
    if (startBtn) {
      startBtn.disabled = packTranslateRunning || !selectedPackTranslateEngine() || total === 0;
      startBtn.textContent = packTranslateRunning ? '翻譯中…' : '開始翻譯';
    }
    packTranslateEl('btnPackTranslateCancel')?.classList.toggle('hidden', !packTranslateRunning);
  };

  const renderPackTranslateEngines = (engines, problems) => {
    packTranslateEngines = engines;
    const listEl = packTranslateEl('packTranslateEngineList');
    const problemsEl = packTranslateEl('packTranslateProblems');
    // Starts on the model the user ran last time; the best one stays labelled as the suggestion
    const preselected = findPreferredEngine(engines) || engines[0];
    if (listEl) {
      // One block per provider, each listed strongest first. The providers keep the order in which they
      // first appear in the overall ranking, so the block holding the suggested model comes first.
      const providers = [...new Set(engines.map((e) => e.provider))];
      const blockStyle = {
        openai: { border: 'border-emerald-500/40', title: 'text-emerald-300' },
        gemini: { border: 'border-sky-500/40', title: 'text-sky-300' },
        groq: { border: 'border-amber-500/40', title: 'text-amber-300' }
      };
      const renderEngineRow = (e) => `
          <label class="flex items-center gap-2 p-2.5 rounded-xl bg-slate-950 border border-slate-800 cursor-pointer">
            <input type="radio" name="packTranslateEngine" value="${escapeHtml(e.id)}" class="accent-violet-400" ${e === preselected ? 'checked' : ''} />
            <span class="min-w-0 flex-1">
              <span class="font-mono font-bold text-white break-all">${escapeHtml(e.model)}</span>
              ${e.priceText ? `<span class="block text-[10px] text-slate-500 font-mono">${escapeHtml(e.priceText)}</span>` : ''}
            </span>
            <span class="px-1.5 py-0.5 rounded-lg text-[10px] font-bold shrink-0 ${e.tier === 1 ? 'bg-emerald-500/20 text-emerald-300' : e.tier === 2 ? 'bg-sky-500/20 text-sky-300' : 'bg-slate-800 text-slate-400'}">${escapeHtml(e.tierLabel)}${e === engines[0] ? '・建議' : ''}</span>
          </label>`;
      listEl.innerHTML = engines.length > 0
        ? providers.map((provider) => {
          const group = engines.filter((e) => e.provider === provider);
          const style = blockStyle[provider] || { border: 'border-slate-700', title: 'text-slate-300' };
          return `
          <div class="rounded-2xl border ${style.border} p-2 space-y-1.5">
            <div class="px-1 text-[11px] font-extrabold ${style.title}">${escapeHtml(group[0].providerLabel)}${group.length > 1 ? '<span class="font-normal text-slate-500">｜由強到弱</span>' : ''}</div>
            ${group.map(renderEngineRow).join('')}
          </div>`;
        }).join('')
        : '<div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-400">沒有可用的翻譯模型。整包翻譯需要 OpenAI 或 Google Gemini（也可用 Groq）的 API 金鑰；免金鑰的機器翻譯品質不夠，這裡不提供。</div>';
      listEl.querySelectorAll('input').forEach((el) => el.addEventListener('change', refreshPackTranslateControls));
    }
    if (problemsEl) {
      problemsEl.innerHTML = problems.map((p) => `<div>⚠️ ${escapeHtml(p)}</div>`).join('');
      problemsEl.classList.toggle('hidden', problems.length === 0);
    }
    packTranslateEl('btnPackTranslateOpenAiSettings')?.classList.toggle('hidden', engines.length > 0 && problems.length === 0);
    refreshPackTranslateControls();
  };

  const closePackTranslateModal = () => {
    modalPackTranslate?.classList.add('hidden');
    focusBtKeyCatcher();
  };

  safeOn('btnOpenPackTranslate', 'click', async () => {
    modalList?.classList.add('hidden');
    modalPackTranslate?.classList.remove('hidden');
    if (packTranslateRunning) return; // Re-opened while a run is in progress: keep showing that run
    packTranslateEl('packTranslateProgressBox')?.classList.add('hidden');
    packTranslateEl('packTranslateResult')?.classList.add('hidden');
    packTranslateEngines = [];
    const listEl = packTranslateEl('packTranslateEngineList');
    if (listEl) listEl.innerHTML = '<div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-400"><i class="fa-solid fa-spinner animate-spin"></i> 正在查詢你的金鑰目前可用的模型…</div>';
    packTranslateEl('packTranslateProblems')?.classList.add('hidden');
    packTranslateEl('btnPackTranslateOpenAiSettings')?.classList.add('hidden');
    refreshPackTranslateControls();
    const token = ++packTranslateOpenToken;
    const { engines, problems } = await listPackTranslationEngines().catch((err) => ({
      engines: [],
      problems: [`查詢模型清單失敗：${err?.message || '未知錯誤'}`]
    }));
    if (token !== packTranslateOpenToken || packTranslateRunning) return;
    renderPackTranslateEngines(engines, problems);
  });

  safeOn('btnClosePackTranslate', 'click', closePackTranslateModal);
  safeOn('btnPackTranslateOpenAiSettings', 'click', () => {
    modalPackTranslate?.classList.add('hidden');
    openAiSettingsModal();
  });
  safeOn('btnPackTranslateCancel', 'click', () => {
    if (!packTranslateRunning) return;
    packTranslateCancelRequested = true;
    const text = packTranslateEl('packTranslateProgressText');
    if (text) text.textContent = '中止中…（等目前這一批回來就停）';
  });

  safeOn('btnPackTranslateStart', 'click', async () => {
    const pack = state.currentPack;
    const engine = selectedPackTranslateEngine();
    if (packTranslateRunning || !pack || !engine) return;
    const scope = document.querySelector('input[name="packTranslateScope"]:checked')?.value === 'all' ? 'all' : 'missing';

    packTranslateRunning = true;
    packTranslateCancelRequested = false;
    const progressBox = packTranslateEl('packTranslateProgressBox');
    const progressFill = packTranslateEl('packTranslateProgressFill');
    const progressText = packTranslateEl('packTranslateProgressText');
    const resultEl = packTranslateEl('packTranslateResult');
    progressBox?.classList.remove('hidden');
    resultEl?.classList.add('hidden');
    if (progressFill) progressFill.style.width = '0%';
    if (progressText) progressText.textContent = '準備中…';
    refreshPackTranslateControls();
    // A locked phone suspends the page and the run with it
    setScreenWakeLockHold('pack-translate', true);

    let result;
    try {
      result = await translatePack(pack, engine, scope, {
        shouldCancel: () => packTranslateCancelRequested,
        onProgress: ({ done, total, note }) => {
          if (progressFill) progressFill.style.width = `${total > 0 ? Math.round((done / total) * 100) : 0}%`;
          if (progressText && !packTranslateCancelRequested) progressText.textContent = `已完成 ${done} / ${total} 句｜${note}`;
        },
        onBatchApplied: () => {
          if (state.currentPack === pack) renderMainStage();
        }
      });
    } catch (err) {
      result = { total: 0, translated: 0, failedIds: [], cancelled: false, saveFailed: false, error: err };
    }
    setScreenWakeLockHold('pack-translate', false);
    packTranslateRunning = false;
    // A model that worked is what the next run (and the translation after transcription) starts from
    if (result.translated > 0 && !result.error) rememberPreferredEngine(engine);

    const lines = [];
    if (result.total === 0 && !result.error) {
      lines.push('<div class="text-slate-300">沒有需要翻譯的句子。</div>');
    } else {
      lines.push(`<div class="${result.translated > 0 ? 'text-emerald-300' : 'text-slate-300'} font-bold">${result.translated > 0 ? '✅' : 'ℹ️'} 已用 ${escapeHtml(engine.model)} 翻譯 ${result.translated} / ${result.total} 句${result.translated > 0 ? '，已存入教材' : ''}</div>`);
    }
    if (result.failedIds.length > 0) {
      lines.push(`<div class="text-amber-200">⚠️ 第 ${result.failedIds.join('、')} 句沒有取得合格的翻譯，維持原狀。再按一次「開始翻譯」可以只補這些句子。</div>`);
    }
    if (result.cancelled) {
      lines.push('<div class="text-slate-300">已中止，前面完成的部分已保留。</div>');
    }
    if (result.error) {
      const reason = describeTranslateError(result.error, engine);
      lines.push(`<div class="text-rose-300">❌ ${escapeHtml(reason)}</div>`);
      lines.push('<div class="text-slate-400">已停止，沒有自動改用其他模型；前面完成的部分已保留。你可以稍後重試，或在上方改選另一個模型。</div>');
      if (typeof window.logDiag === 'function') {
        window.logDiag('WARN', `整包翻譯中斷（${engine.model}，完成 ${result.translated}/${result.total}）：${result.error?.message || result.error}`);
      }
    }
    if (result.saveFailed) {
      lines.push('<div class="text-rose-300">⚠️ 翻譯結果未能寫入裝置，重新整理後會遺失（詳見診斷紀錄）。</div>');
    }
    const usageText = describeUsage(engine, result.usage);
    if (usageText) {
      lines.push(`<div class="text-slate-400 font-mono text-[11px]">🧾 ${escapeHtml(usageText)}</div>`);
      if (typeof window.logDiag === 'function') window.logDiag('INFO', `整包翻譯（${engine.model}）${usageText}`);
    }
    if (resultEl) {
      resultEl.innerHTML = lines.join('');
      resultEl.classList.remove('hidden');
    }
    if (!result.error && !result.cancelled) progressBox?.classList.add('hidden');
    refreshPackTranslateControls();
    if (state.currentPack === pack) renderMainStage();
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
        ? codes.map((code, i) => `<button type="button" data-remove-idx="${i}" title="移除這個按鍵" class="px-1.5 py-0.5 rounded-lg bg-slate-800 hover:bg-rose-950 border border-slate-700 hover:border-rose-500/60 font-mono text-[11px] text-amber-300 hover:text-rose-200 transition">${escapeHtml(describeKeyBinding(code))} <span class="text-slate-500">✕</span></button>`).join('')
        : '<span class="text-[11px] text-slate-500">尚未綁定按鍵</span>';
      const row = document.createElement('div');
      row.className = `p-3 rounded-2xl bg-slate-950 border ${isListening ? 'border-sky-400' : 'border-slate-800'} flex items-center justify-between gap-2`;
      row.innerHTML = `
        <div class="min-w-0">
          <div class="font-bold text-white">${escapeHtml(info.label)}</div>
          <div class="flex flex-wrap gap-1 mt-1">${chipsHtml}</div>
        </div>
        <button type="button" data-k="${k}" class="px-3 py-1.5 rounded-xl ${isListening ? 'bg-sky-500 text-slate-950' : 'bg-slate-800 hover:bg-sky-500 hover:text-slate-950'} font-bold text-xs transition shrink-0">
          ${isListening ? '按 1～3 下…(點此取消)' : '學習按鍵'}
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
          keymapNotice = `已移除「${info.label}」的按鍵 ${describeKeyBinding(removed)}`;
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
  const KEY_ACTION_ORDER = ['prev', 'restart', 'play', 'next', 'speed', 'loop', 'copy', 'ai'];
  const keyActionHandlers = {
    prev: actionPrevSentence,
    restart: actionRestartCurrentSentence,
    next: actionNextSentence,
    speed: actionCycleSpeed,
    loop: actionToggleInfiniteLoop,
    copy: triggerCopyCurrentSentence,
    ai: () => actionAiExplainCurrentSentence(false)
  };

  let heldPlayCode = null;
  let heldPlayTimerId = null;
  let heldPlayLongPressFired = false;
  let lastKeydownHandledCode = '';
  let lastKeydownHandledAt = 0;
  const keyupSwallowCodes = new Set();
  const MULTI_CLICK_WINDOW_MS = 350;

  const clearHeldPlayKey = () => {
    if (heldPlayTimerId) {
      clearTimeout(heldPlayTimerId);
      heldPlayTimerId = null;
    }
    heldPlayCode = null;
    heldPlayLongPressFired = false;
  };

  // `code` is a full binding here: a key code, or "code@2" / "code@3" for a double / triple click
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
    const name = describeKeyBinding(code);
    keymapNotice = takenFrom.length > 0
      ? `按鍵 ${name} 原本綁在「${takenFrom.join('、')}」，已改綁到「${target.label}」`
      : `已將按鍵 ${name} 綁定到「${target.label}」`;
    if (parseKeyBinding(code).clicks > 1) {
      keymapNotice += `。這顆鍵現在有連擊，它的單擊會晚約 ${MULTI_CLICK_WINDOW_MS / 1000} 秒才反應`;
    }
    state.listeningKeyAction = null;
    clearHeldPlayKey();
    saveKeymapSync(state.keymap);
    refreshKeyHints();
    renderKeymapRows();
    showGiantHud('⌨️', `已綁定 ${name}`, target.label, 'border-emerald-400/90');
  };

  // --- Multi-click (double / triple click) detection ---
  // Presses of a key that has a multi-click binding are counted until no further press arrives within
  // the window (or the highest bound count is reached); only then does the matching action run.
  // Keys without a multi-click binding skip all of this and act at once.
  let pendingClickCode = null;
  let pendingClickCount = 0;
  let pendingClickTimerId = null;
  let pendingClickIsLearning = false;

  const findActionForBinding = (binding) =>
    KEY_ACTION_ORDER.find((act) => (state.keymap[act]?.codes || []).includes(binding));

  const runKeyAction = (action) => {
    if (action === 'play') {
      actionTogglePlayPause();
    } else {
      keyActionHandlers[action]();
    }
  };

  const resolvePendingClicks = () => {
    if (pendingClickTimerId) {
      clearTimeout(pendingClickTimerId);
      pendingClickTimerId = null;
    }
    const code = pendingClickCode;
    const count = pendingClickCount;
    const wasLearning = pendingClickIsLearning;
    pendingClickCode = null;
    pendingClickCount = 0;
    pendingClickIsLearning = false;
    if (code === null) return;

    const binding = makeKeyBinding(code, count);
    const name = describeKeyBinding(binding);
    // The keymap window may have been opened, closed or cancelled while the presses were being counted
    if (wasLearning !== Boolean(state.listeningKeyAction)) {
      logKeyEvent(`${name} → 略過（學習狀態在連擊計數期間改變了）`);
      return;
    }
    if (wasLearning) {
      logKeyEvent(`${name} → 學習綁定到「${state.keymap[state.listeningKeyAction]?.label || ''}」`);
      learnBoundKey(binding);
      return;
    }
    const action = findActionForBinding(binding);
    if (!action) {
      logKeyEvent(`${name} → 這個按法沒有綁定任何動作`);
      return;
    }
    logKeyEvent(`${name} → 執行動作：${state.keymap[action]?.label || action}`);
    runKeyAction(action);
  };

  const registerKeyClick = (code, maxClicks, isLearning) => {
    // A press of a different key ends the count for the previous one right away
    if (pendingClickCode !== null && (pendingClickCode !== code || pendingClickIsLearning !== isLearning)) {
      resolvePendingClicks();
    }
    if (pendingClickTimerId) clearTimeout(pendingClickTimerId);
    pendingClickTimerId = null;
    pendingClickCode = code;
    pendingClickCount += 1;
    pendingClickIsLearning = isLearning;
    if (pendingClickCount >= maxClicks) {
      resolvePendingClicks();
      return;
    }
    pendingClickTimerId = setTimeout(resolvePendingClicks, MULTI_CLICK_WINDOW_MS);
  };

  // One physical press of a key that is bound, or of any key while learning.
  // `canHold` is true only for real keydown events, where a matching keyup will follow.
  const handleKeyPress = (code, trace, canHold) => {
    const isLearning = Boolean(state.listeningKeyAction);
    const nth = (pendingClickCode === code && pendingClickIsLearning === isLearning ? pendingClickCount : 0) + 1;

    if (isLearning) {
      trace(`學習中：第 ${nth} 下（停 ${MULTI_CLICK_WINDOW_MS / 1000} 秒後綁定，連按可綁雙擊 / 三擊）`);
      registerKeyClick(code, MAX_KEY_CLICKS, true);
      return;
    }

    const maxClicks = maxClicksBoundToKey(code);
    if (maxClicks > 1) {
      trace(`第 ${nth} 下（這顆鍵設有連擊，停 ${MULTI_CLICK_WINDOW_MS / 1000} 秒後才執行）`);
      registerKeyClick(code, maxClicks, false);
      return;
    }

    // Single-click-only key: act at once
    if (pendingClickCode !== null) resolvePendingClicks();
    const action = findActionForBinding(code);
    if (!action) return;
    if (action === 'play' && canHold) {
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
    trace(`執行動作：${state.keymap[action]?.label || action}`);
    runKeyAction(action);
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

    if (!state.listeningKeyAction && maxClicksBoundToKey(code) === 0) {
      trace(`沒有綁定任何動作（可到「按鍵」視窗把 ${code} 學起來）`);
      return;
    }
    e.preventDefault();
    lastKeydownHandledCode = code;
    lastKeydownHandledAt = Date.now();
    keyupSwallowCodes.add(code);
    if (isCatcher && btCatcher) btCatcher.value = '';

    // A held key auto-repeats keydown; one physical press must count only once
    if (e.repeat) return;
    handleKeyPress(code, trace, true);
  });

  window.addEventListener('keyup', (e) => {
    const code = normalizeKeyCode(e.code, e.key);
    // The release of a key we acted on must not additionally click whichever button has focus (Space does that on keyup)
    if (keyupSwallowCodes.delete(code)) e.preventDefault();
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
      if (!state.listeningKeyAction && maxClicksBoundToKey(code) === 0) {
        trace('沒有綁定任何動作');
        return;
      }
      // No keyup follows an `input` event, so the play key toggles at once instead of waiting for a release
      handleKeyPress(code, trace, false);
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

  // Modal: GPT-Live Real-Time Voice Conversation
  initGptLiveModule({
    onOpenAiSettings: openAiSettingsModal,
    onBlurBtCatcher: blurBtKeyCatcher,
    onFocusBtCatcher: focusBtKeyCatcher
  });
  safeOn('btnOpenGptLive', 'click', () => {
    blurBtKeyCatcher();
    openGptLiveModal();
  });
  safeOn('btnGptLiveExplainSentence', 'click', () => {
    blurBtKeyCatcher();
    openGptLiveAndExplainCurrentSentence();
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
    renderStorageStatusLine();
    refreshStorageUsage().then(renderStorageStatusLine);
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
  // Translate right after transcription: on unless the user switched it off
  const AUTO_TRANSLATE_AFTER_TRANSCRIBE_LS_KEY = 'car_shadowing_auto_translate_after_transcribe_v1';
  const chkAutoTranslateAfterTranscribe = document.getElementById('chkAutoTranslateAfterTranscribe');
  if (chkAutoTranslateAfterTranscribe) {
    chkAutoTranslateAfterTranscribe.checked = safeStorage.getItem(AUTO_TRANSLATE_AFTER_TRANSCRIBE_LS_KEY) !== '0';
    chkAutoTranslateAfterTranscribe.addEventListener('change', () => {
      safeStorage.setItem(AUTO_TRANSLATE_AFTER_TRANSCRIBE_LS_KEY, chkAutoTranslateAfterTranscribe.checked ? '1' : '0');
    });
  }
  let transcribeTranslateCancelRequested = false;

  safeOn('btnAiTranscribeLongAudio', 'click', async () => {
    if (!state.vadAudioBuffer) {
      showGiantHud('⚠️', '請先選擇長音檔', '請先在左側載入 .mp3 / .wav / .m4a 後再點聽打', 'border-amber-400/90');
      return;
    }
    const btn = document.getElementById('btnAiTranscribeLongAudio');
    const statusEl = document.getElementById('aiTranscribeStatus');
    const textarea = document.getElementById('textareaLongSubs');
    const cancelTranslateBtn = document.getElementById('btnCancelTranscribeTranslate');
    const keepNumbers = document.getElementById('chkKeepLineNumbers')?.checked;

    if (btn) btn.disabled = true;
    if (statusEl) {
      statusEl.classList.remove('hidden');
      statusEl.textContent = '⏳ 準備開始 AI 自動聽打...';
    }
    // A locked phone suspends the page, and the transcription or translation with it
    setScreenWakeLockHold('transcribe', true);

    try {
      const result = await transcribeLongAudioWithAi(state.vadAudioBuffer, (msg) => {
        if (statusEl) statusEl.textContent = msg;
      });

      state.vadTranslatedZh = null;
      const lines = result.lines.map((item) => ({ en: String(item.en || '').trim(), zh: String(item.zh || '').trim() }));
      const writeLinesToTextarea = () => {
        if (!textarea) return;
        textarea.value = lines.map((item, idx) => {
          const enPart = keepNumbers ? `${idx + 1}. ${item.en}` : item.en;
          return item.zh ? `${enPart} || ${item.zh}` : enPart;
        }).join('\n');
      };
      writeLinesToTextarea();

      const metaParts = [
        result.trimmedHeadSec > 0.2 ? `已裁切開頭 ${result.trimmedHeadSec.toFixed(1)}s 靜音` : '無開頭靜音',
        `分 ${result.chunkCount || 1} 段`,
        result.resamplerUsed || '16kHz'
      ];
      const metaSummary = metaParts.join('｜');

      const transcribeDoneText = `✅ ${result.modelUsed} 聽打完成：共 ${result.lines.length} 句（${metaSummary}）`;
      if (statusEl) statusEl.textContent = transcribeDoneText;
      if (result.segments && result.segments.length > 0) {
        state.vadSegments = result.segments;
        renderVadChunkListUI();
        drawVadWaveformCanvas();
        showGiantHud('🎙️', `聽打完成 ${result.lines.length} 句`, `${result.modelUsed}｜已套用精準時間軸`, 'border-emerald-400/90');
      } else {
        autoFindMatchingDbThreshold();
        showGiantHud('🎙️', `聽打完成 ${result.lines.length} 句`, '已寫入英文字幕並對齊切點', 'border-emerald-400/90');
      }

      // Second pass: Chinese from the dedicated translation engine, on the finished English transcript
      if (document.getElementById('chkAutoTranslateAfterTranscribe')?.checked) {
        const setTranslateNote = (text) => {
          if (statusEl) statusEl.textContent = `${transcribeDoneText}\n${text}`;
        };
        transcribeTranslateCancelRequested = false;
        cancelTranslateBtn?.classList.remove('hidden');
        // The box is rewritten batch by batch; typing into it meanwhile would be overwritten
        if (textarea) textarea.readOnly = true;
        let outcome;
        try {
          outcome = await translateTranscriptLines(lines, document.getElementById('inputLongPackName')?.value || '', {
            onNote: (text) => setTranslateNote(`🌐 ${transcribeTranslateCancelRequested ? '中止中…（等目前這一批回來就停）' : text}`),
            shouldCancel: () => transcribeTranslateCancelRequested,
            onLinesUpdated: writeLinesToTextarea
          });
        } finally {
          if (textarea) textarea.readOnly = false;
          cancelTranslateBtn?.classList.add('hidden');
        }

        const translatedLines = lines.filter((line) => line.zh && line.zhSource);
        if (translatedLines.length > 0) {
          state.vadTranslatedZh = {
            zhSource: `${PACK_TRANSLATE_ZH_SOURCE_PREFIX}${outcome.engine.model}`,
            pairs: new Set(translatedLines.map((line) => `${line.en}\n${line.zh}`))
          };
        }
        writeLinesToTextarea();
        renderVadChunkListUI();

        const laterHint = '存成教材後，可到「句子清單 → 整包翻譯」處理。';
        if (!outcome.result) {
          setTranslateNote(`🌐 沒有自動翻譯中文：${outcome.noEngineReason}。${laterHint}`);
        } else {
          const { engine, skipped, result: tr } = outcome;
          const notes = [];
          if (skipped.length > 0) {
            notes.push(`ℹ️ 這把金鑰無法使用 ${skipped.map((e) => e.model).join('、')}，已改用 ${engine.model}（${engine.tierLabel}）`);
          }
          notes.push(`🌐 已用 ${engine.model} 翻譯 ${tr.translated} / ${tr.total} 句中文`);
          if (tr.failedIds.length > 0) notes.push(`⚠️ 第 ${tr.failedIds.join('、')} 句沒有取得合格的翻譯`);
          if (tr.cancelled) notes.push('已中止翻譯，完成的部分已保留');
          if (tr.error) {
            notes.push(`❌ 翻譯中斷：${describeTranslateError(tr.error, engine)}`);
            notes.push(`英文字幕不受影響。${laterHint}`);
            if (typeof window.logDiag === 'function') {
              window.logDiag('WARN', `聽打後翻譯中斷（${engine.model}，完成 ${tr.translated}/${tr.total}）：${tr.error?.message || tr.error}`);
            }
          }
          const usageText = describeUsage(engine, tr.usage);
          if (usageText) {
            notes.push(`🧾 ${usageText}`);
            if (typeof window.logDiag === 'function') window.logDiag('INFO', `聽打後翻譯（${engine.model}）${usageText}`);
          }
          setTranslateNote(notes.join('\n'));
          if (tr.error) {
            showGiantHud('⚠️', '中文翻譯沒有完成', `已翻譯 ${tr.translated} / ${tr.total} 句，英文字幕已完成`, 'border-amber-400/90');
          } else if (tr.translated > 0) {
            showGiantHud('🌐', `中文翻譯完成 ${tr.translated} 句`, engine.model, 'border-emerald-400/90');
          }
        }
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
      setScreenWakeLockHold('transcribe', false);
      if (btn) btn.disabled = false;
    }
  });
  safeOn('btnCancelTranscribeTranslate', 'click', () => {
    transcribeTranslateCancelRequested = true;
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
    state.currentPack = newPack;
    state.currentIndex = 0;
    state.repeatCountCurrent = 1;
    state.pausedOffsetSec = 0;
    savePrefsSync();
    renderMainStage();
    modalImport?.classList.add('hidden');
    if (saved) {
      showGiantHud('💾', `已儲存 ${newPack.items.length} 句教材`, newPack.name, 'border-emerald-400/90');
      ensureStorageProtection();
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
      const wasRestored = Boolean(newPack.restoredFromBackup);
      delete newPack.restoredFromBackup;
      const saved = await savePackToDB(newPack);
      state.packs.push(newPack);
      state.currentPack = newPack;
      state.currentIndex = 0;
      state.repeatCountCurrent = 1;
      state.pausedOffsetSec = 0;
      savePrefsSync();
      renderMainStage();
      if (statusEl) {
        statusEl.textContent = saved
          ? `✅ 已成功${wasRestored ? '還原備份' : '匯入'} ${newPack.items.length} 句教材！`
          : `⚠️ 已載入 ${newPack.items.length} 句，但未能寫入裝置（重新整理後會遺失）`;
      }
      if (fileInput) fileInput.value = '';
      modalImport?.classList.add('hidden');
      if (saved) {
        showGiantHud(
          wasRestored ? '♻️' : '📦',
          wasRestored ? `已還原備份 ${newPack.items.length} 句` : `已匯入 ${newPack.items.length} 句教材`,
          wasRestored ? `${newPack.name}（含中譯與 AI 筆記）` : newPack.name,
          'border-emerald-400/90'
        );
        ensureStorageProtection();
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