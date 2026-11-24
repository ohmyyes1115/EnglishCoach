// Layer 2: OpenAI GPT-Live Full-Duplex Voice Session (WebRTC + oai-events DataChannel)

import {
  state,
  safeStorage,
  safeOn,
  escapeHtml,
  formatIdx,
  showGiantHud
} from './state-storage.js';
import { pausePlaybackInPlace } from './player-engine.js';

const GPT_LIVE_CONFIG_LS_KEY = 'car_shadow_gpt_live_config_v1';
const DEFAULT_LIVE_ENDPOINT = 'https://api.openai.com/v1/live/sessions';
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
  reportedSeconds: null,
  contextRatio: null,
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
// PERSISTED PREFERENCES
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

function updateLiveTimerAndCostUI() {
  const timerEl = document.getElementById('gptLiveTimerText');
  const costEl = document.getElementById('gptLiveCostText');
  if (!timerEl || !costEl) return;

  if (liveState.status === 'idle') {
    timerEl.textContent = '00:00';
    costEl.textContent = 'Active $0.05/分｜Standby $0.02/分';
    return;
  }

  const elapsedSec = liveState.startedAtMs > 0
    ? Math.floor((Date.now() - liveState.startedAtMs) / 1000)
    : 0;
  const billSec = liveState.reportedSeconds !== null ? liveState.reportedSeconds : elapsedSec;
  timerEl.textContent = formatDurationMMSS(elapsedSec);

  const estUsd = ((Math.max(15, billSec) / 60) * 0.05).toFixed(3);
  const ratioText = Number.isFinite(liveState.contextRatio)
    ? `｜上下文 ${Math.round(liveState.contextRatio * 100)}%`
    : '';
  costEl.textContent = `估計 ≤ $${estUsd}${ratioText}`;
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
// TRANSCRIPT STREAM RENDERING
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

function cleanupLiveResources() {
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
  liveState.reportedSeconds = null;
  liveState.contextRatio = null;
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
    liveState.status = cfg.standbySec > 0 ? 'standby' : 'active';
    if (!liveState.startedAtMs) liveState.startedAtMs = Date.now();
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
    updateLiveStatusUI();
    return;
  }

  if (type === 'session.paused') {
    liveState.status = 'standby';
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
    const secs = Number(ev.usage?.seconds);
    if (Number.isFinite(secs)) liveState.reportedSeconds = secs;
    const ratio = Number(ev.context_window?.usage_ratio);
    if (Number.isFinite(ratio)) liveState.contextRatio = ratio;
    updateLiveTimerAndCostUI();
    return;
  }

  if (type === 'session.closed') {
    const finalSec = Number(ev.usage?.seconds);
    const reason = ev.reason || 'closed';
    const summary = Number.isFinite(finalSec)
      ? `☎️ 通話已結束（計費時長 ${finalSec} 秒，原因：${reason}）`
      : `☎️ 通話已結束（原因：${reason}）`;
    appendSystemTranscriptNote(summary, 'slate');
    if (typeof window.logDiag === 'function') {
      window.logDiag('INFO', `GPT-Live session.closed: ${summary}`);
    }
    if (liveState.closeResolve) {
      const resolve = liveState.closeResolve;
      liveState.closeResolve = null;
      resolve();
    } else {
      cleanupLiveResources();
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
    showLiveAlert('🔑 尚未設定 OpenAI API Key。請先點右上角「🔑 設定金鑰」填入 OpenAI Paid Tier 的 sk-... 金鑰（GPT-Live 需付費等級帳號）。');
    return;
  }

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    showLiveAlert('❌ 此瀏覽器不支援麥克風存取，請確認使用 HTTPS 網址並以 Safari / Chrome 開啟。');
    return;
  }

  if (state.isPlaying) {
    pausePlaybackInPlace('GPT-Live 對話中');
  }

  liveState.status = 'connecting';
  liveState.isMuted = false;
  liveState.reportedSeconds = null;
  liveState.contextRatio = null;
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
          cleanupLiveResources();
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
        cleanupLiveResources();
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

    liveState.startedAtMs = Date.now();
    liveState.status = cfg.standbySec > 0 ? 'standby' : 'active';
    if (liveState.timerId) clearInterval(liveState.timerId);
    liveState.timerId = setInterval(updateLiveTimerAndCostUI, 1000);
    updateLiveStatusUI();
  } catch (err) {
    const rawMsg = String(err?.message || err || '未知錯誤');
    let friendly = `❌ 無法建立 GPT-Live 連線：${rawMsg}`;
    if (err instanceof TypeError || /failed to fetch|load failed|networkerror/i.test(rawMsg)) {
      friendly = `❌ 連線遭瀏覽器阻擋（CORS 或網路失敗）。OpenAI /v1/live/sessions 若不允許網頁直連，請展開上方「⚙️ 進階設定」填入 Cloudflare Worker / Proxy 中繼網址後再試。`;
    } else if (/NotAllowedError|Permission denied/i.test(rawMsg) || err?.name === 'NotAllowedError') {
      friendly = '❌ 麥克風權限被拒絕，請在瀏覽器網址列或 iOS 設定中允許麥克風權限。';
    }
    showLiveAlert(friendly);
    if (typeof window.logDiag === 'function') {
      window.logDiag('WARN', `GPT-Live 啟動失敗：${rawMsg}`);
    }
    cleanupLiveResources();
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
      }, 1200);
    });
  }

  cleanupLiveResources();
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
  showLiveAlert('');
  updateLiveStatusUI();
  modal.classList.remove('hidden');
}

export async function closeGptLiveModal() {
  const modal = document.getElementById('modalGptLive');
  if (liveState.status !== 'idle') {
    await stopGptLiveSession();
  }
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

  // Ensure active WebRTC session is closed cleanly if page/PWA is closed
  window.addEventListener('beforeunload', () => {
    if (liveState.dc && liveState.dc.readyState === 'open') {
      try { liveState.dc.send(JSON.stringify({ type: 'session.close' })); } catch (e) {}
    }
    if (liveState.pc) {
      try { liveState.pc.close(); } catch (e) {}
    }
  });
}

// EOF: js/gpt-live.js