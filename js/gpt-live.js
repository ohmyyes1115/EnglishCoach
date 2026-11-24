// Layer 2: OpenAI GPT-Live Full-Duplex Voice Session (WebRTC + oai-events DataChannel)
// Includes real-time Active/Standby cost tracking, call settlement summary & local balance ledger

import {
  state,
  safeStorage,
  safeOn,
  formatIdx,
  showGiantHud
} from './state-storage.js';
import { pausePlaybackInPlace } from './player-engine.js';

const GPT_LIVE_CONFIG_LS_KEY = 'car_shadow_gpt_live_config_v1';
const GPT_LIVE_LEDGER_LS_KEY = 'car_shadow_gpt_live_ledger_v1';
const DEFAULT_LIVE_ENDPOINT = 'https://api.openai.com/v1/live/sessions';

const ACTIVE_RATE_PER_MIN = 0.05;
const STANDBY_RATE_PER_MIN = 0.02;
const MIN_INITIAL_ACTIVE_SEC = 15;
const USD_TO_TWD_ESTIMATE = 32.5;

const DEFAULT_LIVE_INSTRUCTIONS = [
  'You are a friendly, concise English speaking coach for a B2-level learner.',
  'Speak natural, clear English at a moderate pace, keeping each turn short (1-3 sentences) so the user gets plenty of speaking practice.',
  'Gently correct major grammar or pronunciation-related phrasing issues only when helpful, and switch to Traditional Chinese briefly only if the user asks for an explanation in Chinese.'
].join(' ');

const liveState = {
  status: 'idle', // 'idle' | 'connecting' | 'active' | 'standby' | 'closing'
  pc: null,
  dc: null,
  localStream: null,
  isMuted: false,
  sessionId: '',
  startedAtMs: 0,
  timerId: null,
  // Real-time billing trackers
  hasEstablishedWebRtc: false,
  sessionSettled: false,
  activeMs: 0,
  standbyMs: 0,
  currentPhase: null, // 'active' | 'standby' | null
  phaseStartedAtMs: 0,
  reportedSeconds: null,
  serverActiveSec: null,
  serverStandbySec: null,
  contextRatio: null,
  // Transcript DOM state
  lastSpeaker: '',
  lastBubbleEl: null,
  closeResolve: null,
  initialized: false
};

let liveCallbacks = {
  onOpenAiSettings: () => {},
  onBlurBtCatcher: () => {},
  onFocusBtCatcher: () => {}
};

// ==========================================
// PERSISTED CONFIG & LOCAL BALANCE LEDGER
// ==========================================
function loadGptLiveConfig() {
  const defaults = {
    model: 'gpt-live-1.1',
    voice: 'marin',
    standbySec: 20,
    useCurrentSentence: true,
    instructions: DEFAULT_LIVE_INSTRUCTIONS,
    endpoint: DEFAULT_LIVE_ENDPOINT
  };
  try {
    const raw = safeStorage.getItem(GPT_LIVE_CONFIG_LS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return {
      model: parsed.model === 'gpt-live-1' ? 'gpt-live-1' : 'gpt-live-1.1',
      voice: typeof parsed.voice === 'string' && parsed.voice ? parsed.voice : 'marin',
      standbySec: Number.isFinite(Number(parsed.standbySec)) ? Number(parsed.standbySec) : 20,
      useCurrentSentence: parsed.useCurrentSentence !== false,
      instructions: typeof parsed.instructions === 'string' && parsed.instructions.trim()
        ? parsed.instructions.trim()
        : DEFAULT_LIVE_INSTRUCTIONS,
      endpoint: typeof parsed.endpoint === 'string' && parsed.endpoint.trim()
        ? parsed.endpoint.trim()
        : DEFAULT_LIVE_ENDPOINT
    };
  } catch (e) {
    return defaults;
  }
}

function readConfigFromUI() {
  const model = document.getElementById('selectGptLiveModel')?.value || 'gpt-live-1.1';
  const voice = document.getElementById('selectGptLiveVoice')?.value || 'marin';
  const standbySec = Number(document.getElementById('selectGptLiveStandby')?.value || 0);
  const useCurrentSentence = Boolean(document.getElementById('chkGptLiveUseCurrentSentence')?.checked);
  const instructions = (document.getElementById('textareaGptLiveInstructions')?.value || '').trim() || DEFAULT_LIVE_INSTRUCTIONS;
  const endpoint = (document.getElementById('inputGptLiveEndpoint')?.value || '').trim() || DEFAULT_LIVE_ENDPOINT;
  return { model, voice, standbySec, useCurrentSentence, instructions, endpoint };
}

function saveGptLiveConfigFromUI() {
  const cfg = readConfigFromUI();
  safeStorage.setItem(GPT_LIVE_CONFIG_LS_KEY, JSON.stringify(cfg));
  return cfg;
}

function applyConfigToUI(cfg) {
  const modelEl = document.getElementById('selectGptLiveModel');
  const voiceEl = document.getElementById('selectGptLiveVoice');
  const standbyEl = document.getElementById('selectGptLiveStandby');
  const chkEl = document.getElementById('chkGptLiveUseCurrentSentence');
  const instEl = document.getElementById('textareaGptLiveInstructions');
  const endEl = document.getElementById('inputGptLiveEndpoint');

  if (modelEl) modelEl.value = cfg.model;
  if (voiceEl) voiceEl.value = cfg.voice;
  if (standbyEl) standbyEl.value = String(cfg.standbySec);
  if (chkEl) chkEl.checked = Boolean(cfg.useCurrentSentence);
  if (instEl) instEl.value = cfg.instructions;
  if (endEl) endEl.value = cfg.endpoint;
}

function loadBillingLedger() {
  const defaults = {
    balanceUsd: null,
    totalSpentUsd: 0,
    sessionCount: 0,
    lastCallCostUsd: null,
    updatedAt: 0
  };
  try {
    const raw = safeStorage.getItem(GPT_LIVE_LEDGER_LS_KEY);
    if (!raw) return defaults;
    const p = JSON.parse(raw);
    return {
      balanceUsd: (p.balanceUsd === null || p.balanceUsd === undefined || !Number.isFinite(Number(p.balanceUsd)))
        ? null
        : Math.max(0, Number(p.balanceUsd)),
      totalSpentUsd: Number.isFinite(Number(p.totalSpentUsd)) ? Math.max(0, Number(p.totalSpentUsd)) : 0,
      sessionCount: Number.isFinite(Number(p.sessionCount)) ? Math.max(0, Math.floor(Number(p.sessionCount))) : 0,
      lastCallCostUsd: Number.isFinite(Number(p.lastCallCostUsd)) ? Math.max(0, Number(p.lastCallCostUsd)) : null,
      updatedAt: Number(p.updatedAt) || 0
    };
  } catch (e) {
    return defaults;
  }
}

function saveBillingLedger(ledger) {
  ledger.updatedAt = Date.now();
  safeStorage.setItem(GPT_LIVE_LEDGER_LS_KEY, JSON.stringify(ledger));
}

// ==========================================
// REAL-TIME BILLING CALCULATOR
// ==========================================
function resetBillingTrackers() {
  liveState.hasEstablishedWebRtc = false;
  liveState.sessionSettled = false;
  liveState.activeMs = 0;
  liveState.standbyMs = 0;
  liveState.currentPhase = null;
  liveState.phaseStartedAtMs = 0;
  liveState.reportedSeconds = null;
  liveState.serverActiveSec = null;
  liveState.serverStandbySec = null;
  liveState.contextRatio = null;
}

function flushCurrentBillingPhase(nowMs = Date.now()) {
  if (!liveState.currentPhase || liveState.phaseStartedAtMs <= 0) return;
  const delta = Math.max(0, nowMs - liveState.phaseStartedAtMs);
  if (liveState.currentPhase === 'active') liveState.activeMs += delta;
  else if (liveState.currentPhase === 'standby') liveState.standbyMs += delta;
  liveState.phaseStartedAtMs = nowMs;
}

function switchBillingPhase(nextPhase, nowMs = Date.now()) {
  if (liveState.currentPhase === nextPhase) return;
  flushCurrentBillingPhase(nowMs);
  liveState.currentPhase = nextPhase;
  liveState.phaseStartedAtMs = nowMs;
}

function applyServerUsagePayload(usage) {
  if (!usage || typeof usage !== 'object') return;
  const totalSecs = Number(usage.seconds);
  if (Number.isFinite(totalSecs) && totalSecs >= 0) {
    liveState.reportedSeconds = totalSecs;
  }
  const activeSecs = Number(usage.active_seconds);
  if (Number.isFinite(activeSecs) && activeSecs >= 0) {
    liveState.serverActiveSec = activeSecs;
  }
  const standbySecs = Number(usage.standby_seconds);
  if (Number.isFinite(standbySecs) && standbySecs >= 0) {
    liveState.serverStandbySec = standbySecs;
  }
}

function computeLiveBillingSnapshot(nowMs = Date.now()) {
  let actMs = liveState.activeMs;
  let stbyMs = liveState.standbyMs;
  if (liveState.currentPhase && liveState.phaseStartedAtMs > 0) {
    const delta = Math.max(0, nowMs - liveState.phaseStartedAtMs);
    if (liveState.currentPhase === 'active') actMs += delta;
    else if (liveState.currentPhase === 'standby') stbyMs += delta;
  }

  const localActiveSec = actMs / 1000;
  const localStandbySec = stbyMs / 1000;
  let activeSec = Number.isFinite(liveState.serverActiveSec) ? liveState.serverActiveSec : localActiveSec;
  const standbySec = Number.isFinite(liveState.serverStandbySec) ? liveState.serverStandbySec : localStandbySec;

  // If server reported total active seconds without breakdown and no standby occurred, calibrate to server
  if (
    Number.isFinite(liveState.reportedSeconds) &&
    !Number.isFinite(liveState.serverActiveSec) &&
    standbySec < 0.5
  ) {
    activeSec = Math.max(activeSec, liveState.reportedSeconds);
  }

  // WebRTC sessions pre-bill 15s of active audio duration (credited against usage, not added on top)
  const billableActiveSec = liveState.hasEstablishedWebRtc
    ? Math.max(MIN_INITIAL_ACTIVE_SEC, activeSec)
    : activeSec;

  const costUsd = (billableActiveSec / 60) * ACTIVE_RATE_PER_MIN + (standbySec / 60) * STANDBY_RATE_PER_MIN;
  const withoutStandbyUsd = (Math.max(liveState.hasEstablishedWebRtc ? MIN_INITIAL_ACTIVE_SEC : 0, activeSec + standbySec) / 60) * ACTIVE_RATE_PER_MIN;
  const savedUsd = Math.max(0, withoutStandbyUsd - costUsd);
  const elapsedSec = liveState.startedAtMs > 0 ? Math.max(0, (nowMs - liveState.startedAtMs) / 1000) : 0;

  return {
    elapsedSec,
    activeSec,
    standbySec,
    billableActiveSec,
    reportedSeconds: liveState.reportedSeconds,
    costUsd,
    costTwd: costUsd * USD_TO_TWD_ESTIMATE,
    savedUsd
  };
}

function finalizeLiveSessionBilling(reason = 'closed') {
  if (liveState.sessionSettled || !liveState.hasEstablishedWebRtc) return;
  liveState.sessionSettled = true;
  flushCurrentBillingPhase();
  liveState.currentPhase = null;

  const snap = computeLiveBillingSnapshot();
  const ledger = loadBillingLedger();
  ledger.totalSpentUsd = Number((ledger.totalSpentUsd + snap.costUsd).toFixed(6));
  ledger.sessionCount += 1;
  ledger.lastCallCostUsd = snap.costUsd;
  if (ledger.balanceUsd !== null) {
    ledger.balanceUsd = Math.max(0, Number((ledger.balanceUsd - snap.costUsd).toFixed(6)));
  }
  saveBillingLedger(ledger);
  renderBalanceLedgerUI();

  appendSettlementCard(snap, ledger, reason);
  if (typeof window.logDiag === 'function') {
    window.logDiag(
      'INFO',
      `GPT-Live 結算 (${reason})：Active ${Math.round(snap.activeSec)}s / Standby ${Math.round(snap.standbySec)}s，預估 $${snap.costUsd.toFixed(4)}`
    );
  }
}

// ==========================================
// CURRENT SENTENCE CONTEXT & UI HELPERS
// ==========================================
function getCurrentSentenceSnapshot() {
  const item = state.currentPack?.items?.[state.currentIndex];
  if (!item) return null;
  const cleanEn = String(item.en || '').replace(/^\d+[\.\)、\-\s]+/, '').trim();
  const cleanZh = String(item.zh || '').trim();
  return {
    idxLabel: `#${formatIdx(state.currentIndex + 1)}`,
    en: cleanEn,
    zh: cleanZh
  };
}

function buildEffectiveInstructions(cfg) {
  let text = cfg.instructions || DEFAULT_LIVE_INSTRUCTIONS;
  if (cfg.useCurrentSentence) {
    const snap = getCurrentSentenceSnapshot();
    if (snap && snap.en) {
      text += `\nCurrent practice sentence (${snap.idxLabel}): "${snap.en}"${snap.zh ? ` (Meaning: ${snap.zh})` : ''}. Start by greeting briefly and inviting the learner to practice or discuss this sentence.`;
    }
  }
  return text;
}

function renderCurrentSentencePreview() {
  const el = document.getElementById('gptLiveCurrentSentencePreview');
  if (!el) return;
  const snap = getCurrentSentenceSnapshot();
  if (!snap || !snap.en) {
    el.textContent = '目前教材尚無句子';
    return;
  }
  el.textContent = `${snap.idxLabel} ${snap.en}`;
}

function showLiveAlert(msg = '') {
  const box = document.getElementById('gptLiveAlertBox');
  if (!box) return;
  if (!msg) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  box.classList.remove('hidden');
  box.textContent = msg;
}

function formatDurationMMSS(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function renderBalanceLedgerUI() {
  const balEl = document.getElementById('gptLiveBalanceText');
  const cumEl = document.getElementById('gptLiveCumulativeText');
  const ledger = loadBillingLedger();

  if (balEl) {
    if (ledger.balanceUsd === null) {
      balEl.textContent = '未設定（可點設餘額）';
      balEl.className = 'font-mono text-xs font-bold text-slate-400';
    } else {
      // Subtract current in-flight call cost for live preview without mutating saved ledger yet
      const liveDelta = (liveState.hasEstablishedWebRtc && !liveState.sessionSettled)
        ? computeLiveBillingSnapshot().costUsd
        : 0;
      const previewBal = Math.max(0, ledger.balanceUsd - liveDelta);
      balEl.textContent = `$${previewBal.toFixed(4)}`;
      if (previewBal < 0.5) {
        balEl.className = 'font-mono text-xs font-black text-rose-400';
      } else if (previewBal < 2.0) {
        balEl.className = 'font-mono text-xs font-black text-amber-300';
      } else {
        balEl.className = 'font-mono text-xs font-black text-emerald-300';
      }
    }
  }

  if (cumEl) {
    cumEl.textContent = `累計 ${ledger.sessionCount} 通・$${ledger.totalSpentUsd.toFixed(3)}`;
  }
}

function updateLiveTimerAndCostUI() {
  const timerEl = document.getElementById('gptLiveTimerText');
  const costEl = document.getElementById('gptLiveCostText');
  const liveUsdEl = document.getElementById('gptLiveLiveCostUsd');
  const liveTwdEl = document.getElementById('gptLiveLiveCostTwd');
  const breakdownEl = document.getElementById('gptLivePhaseBreakdown');

  if (liveState.status === 'idle') {
    const ledger = loadBillingLedger();
    if (timerEl) timerEl.textContent = '00:00';
    if (costEl) costEl.textContent = 'Active $0.05/分｜Standby $0.02/分';
    if (liveUsdEl) {
      liveUsdEl.textContent = ledger.lastCallCostUsd !== null
        ? `$${ledger.lastCallCostUsd.toFixed(4)}`
        : '$0.0000';
    }
    if (liveTwdEl) {
      liveTwdEl.textContent = ledger.lastCallCostUsd !== null
        ? `上通約 NT$${(ledger.lastCallCostUsd * USD_TO_TWD_ESTIMATE).toFixed(1)}`
        : '約 NT$0.0';
    }
    if (breakdownEl) {
      breakdownEl.textContent = 'Active 00:00｜Standby 00:00（建立最低計 15s）';
    }
    renderBalanceLedgerUI();
    return;
  }

  const snap = computeLiveBillingSnapshot();
  if (timerEl) timerEl.textContent = formatDurationMMSS(snap.elapsedSec);
  if (costEl) {
    const ratioText = Number.isFinite(liveState.contextRatio)
      ? `上下文 ${Math.round(liveState.contextRatio * 100)}%`
      : (liveState.status === 'standby' ? 'Standby $0.02/分' : 'Active $0.05/分');
    const serverNote = Number.isFinite(snap.reportedSeconds) ? `｜官方 ${snap.reportedSeconds}s` : '';
    costEl.textContent = `${ratioText}${serverNote}`;
  }
  if (liveUsdEl) liveUsdEl.textContent = `$${snap.costUsd.toFixed(4)}`;
  if (liveTwdEl) liveTwdEl.textContent = `約 NT$${snap.costTwd.toFixed(1)}`;
  if (breakdownEl) {
    const savedPart = snap.savedUsd >= 0.0005 ? `｜已省 $${snap.savedUsd.toFixed(4)}` : '';
    breakdownEl.textContent = `Active ${formatDurationMMSS(snap.activeSec)}｜Standby ${formatDurationMMSS(snap.standbySec)}${savedPart}`;
  }
  renderBalanceLedgerUI();
}

function updateLiveStatusUI() {
  const dot = document.getElementById('gptLiveStatusDot');
  const text = document.getElementById('gptLiveStatusText');
  const sidBadge = document.getElementById('gptLiveSessionIdBadge');
  const btnCall = document.getElementById('btnGptLiveToggleCall');
  const iconCall = document.getElementById('iconGptLiveCall');
  const labelCall = document.getElementById('labelGptLiveCall');
  const btnMute = document.getElementById('btnGptLiveMute');
  const iconMute = document.getElementById('iconGptLiveMute');
  const labelMute = document.getElementById('labelGptLiveMute');
  const inputText = document.getElementById('inputGptLiveTextPrompt');
  const btnSendText = document.getElementById('btnGptLiveSendText');
  const btnInject = document.getElementById('btnGptLiveInjectSentence');

  const isConnected = liveState.status === 'active' || liveState.status === 'standby';
  const isBusy = liveState.status === 'connecting' || liveState.status === 'closing';

  const statusMap = {
    idle: { dot: 'bg-slate-500', label: '待命就緒', cls: 'text-slate-300' },
    connecting: { dot: 'bg-sky-400 animate-ping', label: '建立 WebRTC 語音連線中...', cls: 'text-sky-300' },
    active: { dot: 'bg-emerald-400 animate-pulse', label: '通話中 (Active・全雙工可隨時插話)', cls: 'text-emerald-300' },
    standby: { dot: 'bg-amber-400 animate-pulse', label: '省費待命中 (Standby・開口即喚醒)', cls: 'text-amber-300' },
    closing: { dot: 'bg-rose-400', label: '正在結束並結算連線...', cls: 'text-rose-300' }
  };
  const info = statusMap[liveState.status] || statusMap.idle;
  if (dot) dot.className = `w-2.5 h-2.5 rounded-full shrink-0 ${info.dot}`;
  if (text) {
    text.textContent = info.label;
    text.className = `font-extrabold truncate ${info.cls}`;
  }
  if (sidBadge) {
    if (liveState.sessionId) {
      sidBadge.textContent = liveState.sessionId.slice(0, 14);
      sidBadge.classList.remove('hidden');
    } else {
      sidBadge.textContent = '';
      sidBadge.classList.add('hidden');
    }
  }

  // Lock session startup settings while connected
  ['selectGptLiveModel', 'selectGptLiveVoice', 'selectGptLiveStandby', 'inputGptLiveEndpoint'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = liveState.status !== 'idle';
  });

  if (btnCall && iconCall && labelCall) {
    btnCall.disabled = isBusy;
    if (isConnected) {
      btnCall.className = 'flex-1 sm:flex-none px-6 py-2.5 rounded-xl bg-rose-500 hover:bg-rose-400 text-white text-xs sm:text-sm font-black shadow-lg shadow-rose-500/25 transition flex items-center justify-center gap-2 disabled:opacity-50';
      iconCall.className = 'fa-solid fa-phone-slash';
      labelCall.textContent = '結束通話';
    } else if (liveState.status === 'connecting') {
      btnCall.className = 'flex-1 sm:flex-none px-6 py-2.5 rounded-xl bg-sky-500 text-slate-950 text-xs sm:text-sm font-black transition flex items-center justify-center gap-2 opacity-80';
      iconCall.className = 'fa-solid fa-spinner animate-spin';
      labelCall.textContent = '連線中...';
    } else {
      btnCall.className = 'flex-1 sm:flex-none px-6 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs sm:text-sm font-black shadow-lg shadow-emerald-500/25 transition flex items-center justify-center gap-2 disabled:opacity-50';
      iconCall.className = 'fa-solid fa-phone';
      labelCall.textContent = '🎙️ 開始即時對話';
    }
  }

  if (btnMute && iconMute && labelMute) {
    btnMute.disabled = !isConnected;
    if (liveState.isMuted) {
      btnMute.className = 'px-3.5 py-2.5 rounded-xl bg-rose-950/80 hover:bg-rose-900 border border-rose-500/60 text-rose-200 text-xs font-extrabold transition disabled:opacity-40 flex items-center gap-1.5';
      iconMute.className = 'fa-solid fa-microphone-slash';
      labelMute.textContent = '已靜音';
    } else {
      btnMute.className = 'px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-extrabold transition disabled:opacity-40 flex items-center gap-1.5';
      iconMute.className = 'fa-solid fa-microphone';
      labelMute.textContent = '麥克風開啟';
    }
  }

  if (inputText) inputText.disabled = !isConnected;
  if (btnSendText) btnSendText.disabled = !isConnected;
  if (btnInject) btnInject.classList.toggle('hidden', !isConnected);

  updateLiveTimerAndCostUI();
}

// ==========================================
// TRANSCRIPT & SETTLEMENT CARD RENDERING
// ==========================================
function ensureTranscriptReady() {
  const list = document.getElementById('gptLiveTranscriptList');
  if (!list) return null;
  if (list.dataset.empty !== '0') {
    list.innerHTML = '';
    list.dataset.empty = '0';
  }
  return list;
}

function appendSystemTranscriptNote(text, tone = 'slate') {
  const list = ensureTranscriptReady();
  if (!list) return;
  liveState.lastSpeaker = '';
  liveState.lastBubbleEl = null;

  const toneCls = tone === 'rose'
    ? 'bg-rose-950/40 border-rose-500/40 text-rose-200'
    : tone === 'emerald'
      ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
      : 'bg-slate-900 border-slate-800 text-slate-400';

  const row = document.createElement('div');
  row.className = `text-center text-[11px] font-bold px-2.5 py-1 rounded-xl border ${toneCls}`;
  row.textContent = text;
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}

function appendSettlementCard(snap, ledger, reason) {
  const list = ensureTranscriptReady();
  if (!list) return;
  liveState.lastSpeaker = '';
  liveState.lastBubbleEl = null;

  const card = document.createElement('div');
  card.className = 'p-3 rounded-2xl bg-amber-950/30 border border-amber-500/40 text-[11px] space-y-1.5 select-text';

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between gap-2 font-black text-amber-300';
  header.innerHTML = `<span>🧾 本通通話費用結算</span><span class="font-mono">$${snap.costUsd.toFixed(4)}（約 NT$${snap.costTwd.toFixed(1)}）</span>`;

  const lines = [
    `總時長 ${formatDurationMMSS(snap.elapsedSec)} ｜ Active ${formatDurationMMSS(snap.activeSec)}（計費 ${Math.round(snap.billableActiveSec)}s）｜ Standby ${formatDurationMMSS(snap.standbySec)}`
  ];
  if (Number.isFinite(snap.reportedSeconds)) {
    lines.push(`OpenAI 回報計費秒數：${snap.reportedSeconds} 秒（結束原因：${reason}）`);
  } else {
    lines.push(`結束原因：${reason}（依本機 Active/Standby 秒數估算）`);
  }
  if (snap.savedUsd >= 0.0005) {
    lines.push(`Standby 省費模式本次約省下 $${snap.savedUsd.toFixed(4)}`);
  }
  if (ledger.balanceUsd !== null) {
    lines.push(`已自動從預估餘額扣款，剩餘約 $${ledger.balanceUsd.toFixed(4)}`);
  }

  const body = document.createElement('div');
  body.className = 'text-slate-300 font-mono text-[10px] space-y-0.5 leading-relaxed';
  lines.forEach((line) => {
    const p = document.createElement('div');
    p.textContent = line;
    body.appendChild(p);
  });

  card.append(header, body);
  list.appendChild(card);
  list.scrollTop = list.scrollHeight;
}

function appendTranscriptDelta(speaker, deltaText) {
  const chunk = String(deltaText || '');
  if (!chunk) return;
  const list = ensureTranscriptReady();
  if (!list) return;

  if (liveState.lastSpeaker === speaker && liveState.lastBubbleEl) {
    liveState.lastBubbleEl.textContent += chunk;
    list.scrollTop = list.scrollHeight;
    return;
  }

  const isUser = speaker === 'user';
  const wrapper = document.createElement('div');
  wrapper.className = `flex flex-col ${isUser ? 'items-end' : 'items-start'}`;

  const label = document.createElement('span');
  label.className = `text-[10px] font-bold mb-0.5 ${isUser ? 'text-sky-400' : 'text-emerald-400'}`;
  label.textContent = isUser ? '你 (You)' : 'GPT-Live';

  const bubble = document.createElement('div');
  bubble.className = isUser
    ? 'max-w-[85%] px-3 py-2 rounded-2xl rounded-tr-sm bg-sky-500/20 border border-sky-400/40 text-white leading-relaxed select-text'
    : 'max-w-[85%] px-3 py-2 rounded-2xl rounded-tl-sm bg-slate-900 border border-emerald-500/30 text-slate-100 leading-relaxed select-text';
  bubble.textContent = chunk.trimStart();

  wrapper.append(label, bubble);
  list.appendChild(wrapper);
  list.scrollTop = list.scrollHeight;

  liveState.lastSpeaker = speaker;
  liveState.lastBubbleEl = bubble;
}

function clearTranscriptUI() {
  const list = document.getElementById('gptLiveTranscriptList');
  if (!list) return;
  list.dataset.empty = '1';
  liveState.lastSpeaker = '';
  liveState.lastBubbleEl = null;
  list.innerHTML = '<div class="text-center py-8 text-slate-500">點擊下方「🎙️ 開始即時對話」建立 WebRTC 語音連線（需授權麥克風與 OpenAI Paid Tier 金鑰）</div>';
}

// ==========================================
// WEBRTC & OAI-EVENTS DATA CHANNEL CORE
// ==========================================
function waitForIceGatheringComplete(pc, timeoutMs = 2000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener('icegatheringstatechange', onStateChange);
      clearTimeout(timer);
      resolve();
    };
    const onStateChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onStateChange);
  });
}

function sendDataChannelEvent(payload) {
  if (!liveState.dc || liveState.dc.readyState !== 'open') return false;
  try {
    liveState.dc.send(JSON.stringify(payload));
    return true;
  } catch (e) {
    return false;
  }
}

function setAudioSessionTypeSafe(type) {
  try {
    if (navigator.audioSession && navigator.audioSession.type !== type) {
      navigator.audioSession.type = type;
    }
  } catch (e) {}
}

function cleanupLiveResources(settleReason = '') {
  if (settleReason && liveState.hasEstablishedWebRtc && !liveState.sessionSettled) {
    finalizeLiveSessionBilling(settleReason);
  }
  if (liveState.timerId) {
    clearInterval(liveState.timerId);
    liveState.timerId = null;
  }
  if (liveState.dc) {
    try { liveState.dc.onmessage = null; } catch (e) {}
    try { liveState.dc.onclose = null; } catch (e) {}
    try { liveState.dc.close(); } catch (e) {}
    liveState.dc = null;
  }
  if (liveState.pc) {
    try { liveState.pc.ontrack = null; } catch (e) {}
    try { liveState.pc.onconnectionstatechange = null; } catch (e) {}
    try { liveState.pc.close(); } catch (e) {}
    liveState.pc = null;
  }
  if (liveState.localStream) {
    liveState.localStream.getTracks().forEach((track) => {
      try { track.stop(); } catch (e) {}
    });
    liveState.localStream = null;
  }
  const remoteAudio = document.getElementById('gptLiveRemoteAudio');
  if (remoteAudio) {
    try { remoteAudio.pause(); } catch (e) {}
    remoteAudio.srcObject = null;
  }
  setAudioSessionTypeSafe('playback');
  liveState.isMuted = false;
  liveState.sessionId = '';
  liveState.startedAtMs = 0;
  resetBillingTrackers();
  liveState.status = 'idle';
  liveState.closeResolve = null;
  updateLiveStatusUI();
}

function handleServerEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  const type = String(ev.type || '');

  if (type === 'session.started') {
    if (ev.session?.id) liveState.sessionId = ev.session.id;
    const cfg = readConfigFromUI();
    if (!liveState.startedAtMs) liveState.startedAtMs = Date.now();
    if (!liveState.currentPhase) {
      const initialPhase = cfg.standbySec > 0 ? 'standby' : 'active';
      liveState.status = initialPhase;
      switchBillingPhase(initialPhase);
    }
    updateLiveStatusUI();
    const modelLabel = ev.session?.model || cfg.model;
    const voiceLabel = ev.session?.audio?.output?.voice || cfg.voice;
    appendSystemTranscriptNote(
      `✅ 已連上 ${modelLabel}（語音：${voiceLabel}）${cfg.standbySec > 0 ? `｜已開啟 ${cfg.standbySec} 秒靜音 Standby` : ''}，直接開口說話即可`,
      'emerald'
    );
    return;
  }

  if (type === 'session.resumed') {
    liveState.status = 'active';
    switchBillingPhase('active');
    updateLiveStatusUI();
    return;
  }

  if (type === 'session.paused') {
    liveState.status = 'standby';
    switchBillingPhase('standby');
    updateLiveStatusUI();
    return;
  }

  if (type === 'session.input_transcript.delta') {
    appendTranscriptDelta('user', ev.delta);
    return;
  }

  if (type === 'session.output_transcript.delta') {
    appendTranscriptDelta('assistant', ev.delta);
    return;
  }

  if (type === 'session.input_audio.muted') {
    liveState.isMuted = true;
    updateLiveStatusUI();
    return;
  }

  if (type === 'session.input_audio.unmuted') {
    liveState.isMuted = false;
    updateLiveStatusUI();
    return;
  }

  if (type === 'session.usage.updated') {
    applyServerUsagePayload(ev.usage);
    const ratio = Number(ev.context_window?.usage_ratio);
    if (Number.isFinite(ratio)) liveState.contextRatio = ratio;
    updateLiveTimerAndCostUI();
    return;
  }

  if (type === 'session.closed') {
    applyServerUsagePayload(ev.usage);
    const reason = ev.reason || 'closed';
    finalizeLiveSessionBilling(reason);
    if (liveState.closeResolve) {
      const resolve = liveState.closeResolve;
      liveState.closeResolve = null;
      resolve();
    } else {
      cleanupLiveResources('');
    }
    return;
  }

  if (type === 'error') {
    const errMsg = ev.error?.message || ev.error?.code || 'GPT-Live 伺服器回傳錯誤';
    showLiveAlert(`⚠️ GPT-Live 錯誤：${errMsg}`);
    appendSystemTranscriptNote(`❌ ${errMsg}`, 'rose');
    if (typeof window.logDiag === 'function') {
      window.logDiag('WARN', `GPT-Live event error: ${errMsg}`);
    }
  }
}

export async function startGptLiveSession() {
  if (liveState.status !== 'idle') return;
  showLiveAlert('');

  const cfg = saveGptLiveConfigFromUI();
  const apiKey = String(state.aiConfig?.openaiKey || '').trim();
  const isDefaultOpenAi = /^https:\/\/api\.openai\.com\//i.test(cfg.endpoint);

  if (isDefaultOpenAi && !apiKey) {
    showLiveAlert('🔑 尚未設定 OpenAI API Key。請先點右上角「🔑 金鑰」填入 OpenAI Paid Tier 的 sk-... 金鑰（GPT-Live 需付費等級帳號）。');
    return;
  }

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    showLiveAlert('❌ 此瀏覽器不支援麥克風存取，請確認使用 HTTPS 網址並以 Safari / Chrome 開啟。');
    return;
  }

  if (state.isPlaying) {
    pausePlaybackInPlace('GPT-Live 對話中');
  }

  resetBillingTrackers();
  liveState.status = 'connecting';
  liveState.isMuted = false;
  updateLiveStatusUI();

  try {
    // 1. Capture microphone directly inside user gesture for iOS Safari compatibility
    setAudioSessionTypeSafe('play-and-record');
    const localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    liveState.localStream = localStream;

    // 2. Setup RTCPeerConnection + remote audio playback + oai-events data channel
    const pc = new RTCPeerConnection();
    liveState.pc = pc;

    const remoteAudio = document.getElementById('gptLiveRemoteAudio');
    pc.ontrack = (event) => {
      if (remoteAudio && event.streams && event.streams[0]) {
        remoteAudio.srcObject = event.streams[0];
        remoteAudio.play().catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      if (!liveState.pc) return;
      const st = pc.connectionState;
      if (st === 'failed' || st === 'disconnected' || st === 'closed') {
        if (liveState.status !== 'idle' && liveState.status !== 'closing') {
          appendSystemTranscriptNote(`⚠️ WebRTC 連線中斷 (${st})`, 'rose');
          cleanupLiveResources(`webrtc_${st}`);
        }
      }
    };

    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    const dc = pc.createDataChannel('oai-events');
    liveState.dc = dc;
    dc.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        handleServerEvent(parsed);
      } catch (e) {}
    };
    dc.onclose = () => {
      if (liveState.status !== 'idle' && liveState.status !== 'closing') {
        cleanupLiveResources('datachannel_closed');
      }
    };

    // 3. Create SDP offer and gather ICE candidates
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc, 2000);

    const sessionConfig = {
      model: cfg.model,
      instructions: buildEffectiveInstructions(cfg),
      audio: {
        output: {
          voice: cfg.voice
        }
      }
    };
    if (cfg.standbySec >= 5 && cfg.standbySec <= 60) {
      sessionConfig.wake_policy = { type: 'speech', vad_threshold: 0.5 };
      sessionConfig.idle_timeout_s = cfg.standbySec;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    // 4. Exchange SDP offer for SDP answer via POST /v1/live/sessions (or custom proxy URL)
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        session: sessionConfig,
        transport: {
          type: 'webrtc',
          sdp: pc.localDescription.sdp
        }
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const apiMsg = data?.error?.message || data?.message || `HTTP ${res.status}`;
      throw new Error(apiMsg);
    }

    const answerSdp = data?.transport?.sdp;
    if (!answerSdp) {
      throw new Error('伺服器回應缺少 WebRTC SDP answer（transport.sdp）');
    }

    liveState.sessionId = data?.session?.id || '';
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    const nowMs = Date.now();
    const initialPhase = cfg.standbySec > 0 ? 'standby' : 'active';
    liveState.hasEstablishedWebRtc = true;
    liveState.startedAtMs = nowMs;
    liveState.status = initialPhase;
    switchBillingPhase(initialPhase, nowMs);

    if (liveState.timerId) clearInterval(liveState.timerId);
    liveState.timerId = setInterval(updateLiveTimerAndCostUI, 1000);
    updateLiveStatusUI();
  } catch (err) {
    const rawMsg = String(err?.message || err || '未知錯誤');
    let friendly = `❌ 無法建立 GPT-Live 連線：${rawMsg}`;
    if (err instanceof TypeError || /failed to fetch|load failed|networkerror/i.test(rawMsg)) {
      friendly = '❌ 連線遭瀏覽器阻擋（CORS 或網路失敗）。OpenAI /v1/live/sessions 若不允許網頁直連，請展開上方「⚙️ 進階設定」填入 Cloudflare Worker / Proxy 中繼網址後再試。';
    } else if (/NotAllowedError|Permission denied/i.test(rawMsg) || err?.name === 'NotAllowedError') {
      friendly = '❌ 麥克風權限被拒絕，請在瀏覽器網址列或 iOS 設定中允許麥克風權限。';
    }
    showLiveAlert(friendly);
    if (typeof window.logDiag === 'function') {
      window.logDiag('WARN', `GPT-Live 啟動失敗：${rawMsg}`);
    }
    cleanupLiveResources('');
  }
}

export async function stopGptLiveSession() {
  if (liveState.status === 'idle') return;
  if (liveState.status === 'closing') return;

  liveState.status = 'closing';
  updateLiveStatusUI();

  if (liveState.dc && liveState.dc.readyState === 'open') {
    await new Promise((resolve) => {
      liveState.closeResolve = resolve;
      sendDataChannelEvent({ type: 'session.close' });
      setTimeout(() => {
        if (liveState.closeResolve) {
          liveState.closeResolve = null;
          resolve();
        }
      }, 1500);
    });
  }

  cleanupLiveResources('user_hangup');
}

function toggleGptLiveMute() {
  if (liveState.status !== 'active' && liveState.status !== 'standby') return;
  const nextMuted = !liveState.isMuted;
  liveState.isMuted = nextMuted;

  if (liveState.localStream) {
    liveState.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
  }
  sendDataChannelEvent({
    type: nextMuted ? 'session.input_audio.mute' : 'session.input_audio.unmute'
  });
  updateLiveStatusUI();
}

function sendMidCallTextPrompt(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return;
  if (liveState.status !== 'active' && liveState.status !== 'standby') return;

  const ok = sendDataChannelEvent({
    type: 'session.commentary.append',
    delegation_id: null,
    content: `User text input during conversation: ${text}. Please respond naturally in voice.`
  });
  if (ok) {
    appendTranscriptDelta('user', `[文字] ${text}`);
    liveState.lastSpeaker = '';
    liveState.lastBubbleEl = null;
  } else {
    showLiveAlert('⚠️ 事件通道尚未就緒，請稍候再送出文字。');
  }
}

// ==========================================
// BALANCE EDITOR CONTROLS
// ==========================================
function openBalanceEditor() {
  const editor = document.getElementById('gptLiveBalanceEditor');
  const input = document.getElementById('inputGptLiveBalanceUsd');
  if (!editor || !input) return;
  const ledger = loadBillingLedger();
  input.value = ledger.balanceUsd !== null ? ledger.balanceUsd.toFixed(2) : '';
  editor.classList.remove('hidden');
  try { input.focus(); input.select(); } catch (e) {}
}

function closeBalanceEditor() {
  document.getElementById('gptLiveBalanceEditor')?.classList.add('hidden');
}

function saveBalanceFromEditor() {
  const input = document.getElementById('inputGptLiveBalanceUsd');
  if (!input) return;
  const raw = String(input.value || '').trim();
  const ledger = loadBillingLedger();
  if (raw === '') {
    ledger.balanceUsd = null;
  } else {
    const val = Number(raw);
    if (!Number.isFinite(val) || val < 0) {
      showLiveAlert('⚠️ 請輸入有效的非負美金金額（例如 10.00）。');
      return;
    }
    ledger.balanceUsd = Number(val.toFixed(4));
  }
  saveBillingLedger(ledger);
  closeBalanceEditor();
  renderBalanceLedgerUI();
  showGiantHud(
    '🏦',
    ledger.balanceUsd !== null ? `預估餘額已設為 $${ledger.balanceUsd.toFixed(2)}` : '已清除預估餘額',
    '往後每次 GPT-Live 通話結束將自動扣款記帳',
    'border-emerald-400/90'
  );
}

// ==========================================
// PUBLIC MODAL CONTROLS & INITIALIZATION
// ==========================================
export function openGptLiveModal() {
  const modal = document.getElementById('modalGptLive');
  if (!modal) return;
  if (state.isPlaying) {
    pausePlaybackInPlace('開啟 GPT-Live');
  }
  const cfg = loadGptLiveConfig();
  applyConfigToUI(cfg);
  renderCurrentSentencePreview();
  closeBalanceEditor();
  showLiveAlert('');
  updateLiveStatusUI();
  modal.classList.remove('hidden');
}

export async function closeGptLiveModal() {
  const modal = document.getElementById('modalGptLive');
  if (liveState.status !== 'idle') {
    await stopGptLiveSession();
  }
  closeBalanceEditor();
  modal?.classList.add('hidden');
  liveCallbacks.onFocusBtCatcher();
}

export function initGptLiveModule(cbs = {}) {
  if (typeof cbs.onOpenAiSettings === 'function') liveCallbacks.onOpenAiSettings = cbs.onOpenAiSettings;
  if (typeof cbs.onBlurBtCatcher === 'function') liveCallbacks.onBlurBtCatcher = cbs.onBlurBtCatcher;
  if (typeof cbs.onFocusBtCatcher === 'function') liveCallbacks.onFocusBtCatcher = cbs.onFocusBtCatcher;

  if (liveState.initialized) return;
  liveState.initialized = true;

  safeOn('btnCloseGptLiveModal', 'click', () => {
    closeGptLiveModal();
  });

  safeOn('btnGptLiveOpenKey', 'click', () => {
    liveCallbacks.onBlurBtCatcher();
    liveCallbacks.onOpenAiSettings();
  });

  safeOn('btnGptLiveToggleCall', 'click', () => {
    if (liveState.status === 'idle') {
      startGptLiveSession();
    } else {
      stopGptLiveSession();
    }
  });

  safeOn('btnGptLiveMute', 'click', toggleGptLiveMute);
  safeOn('btnGptLiveClearTranscript', 'click', clearTranscriptUI);

  // Balance ledger editor bindings
  safeOn('btnGptLiveToggleBalanceEditor', 'click', () => {
    const editor = document.getElementById('gptLiveBalanceEditor');
    if (editor && !editor.classList.contains('hidden')) closeBalanceEditor();
    else openBalanceEditor();
  });
  safeOn('btnGptLiveSaveBalance', 'click', saveBalanceFromEditor);
  safeOn('btnGptLiveCancelBalance', 'click', closeBalanceEditor);
  safeOn('inputGptLiveBalanceUsd', 'keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      saveBalanceFromEditor();
    }
  });
  safeOn('btnGptLiveResetSpent', 'click', () => {
    const ledger = loadBillingLedger();
    ledger.totalSpentUsd = 0;
    ledger.sessionCount = 0;
    ledger.lastCallCostUsd = null;
    saveBillingLedger(ledger);
    updateLiveTimerAndCostUI();
    showGiantHud('🔄', '已歸零累計花費', '僅重置本機統計，不影響餘額設定', 'border-sky-400/90');
  });

  safeOn('btnGptLiveInjectSentence', 'click', () => {
    const snap = getCurrentSentenceSnapshot();
    if (!snap || !snap.en) return;
    const ok = sendDataChannelEvent({
      type: 'session.commentary.append',
      delegation_id: null,
      content: `Let's switch to practicing this sentence (${snap.idxLabel}): "${snap.en}". Please read or discuss it briefly and ask me to practice.`
    });
    if (ok) {
      appendSystemTranscriptNote(`📌 已送入練習句子：${snap.idxLabel} ${snap.en}`, 'emerald');
      showGiantHud('📌', '已帶入本句', snap.en, 'border-emerald-400/90');
    }
  });

  const handleSendText = () => {
    const input = document.getElementById('inputGptLiveTextPrompt');
    if (!input) return;
    const val = input.value.trim();
    if (!val) return;
    input.value = '';
    sendMidCallTextPrompt(val);
  };
  safeOn('btnGptLiveSendText', 'click', handleSendText);
  safeOn('inputGptLiveTextPrompt', 'keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      handleSendText();
    }
  });

  // Persist setting changes automatically
  [
    'selectGptLiveModel',
    'selectGptLiveVoice',
    'selectGptLiveStandby',
    'chkGptLiveUseCurrentSentence',
    'textareaGptLiveInstructions',
    'inputGptLiveEndpoint'
  ].forEach((id) => {
    safeOn(id, 'change', saveGptLiveConfigFromUI);
  });

  // Ensure active WebRTC session is closed & settled cleanly if page/PWA is closed
  window.addEventListener('beforeunload', () => {
    if (liveState.hasEstablishedWebRtc && !liveState.sessionSettled) {
      finalizeLiveSessionBilling('page_unload');
    }
    if (liveState.dc && liveState.dc.readyState === 'open') {
      try { liveState.dc.send(JSON.stringify({ type: 'session.close' })); } catch (e) {}
    }
    if (liveState.pc) {
      try { liveState.pc.close(); } catch (e) {}
    }
  });
}

// EOF: js/gpt-live.js