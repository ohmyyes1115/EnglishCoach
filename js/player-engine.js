// Layer 2: Playback Engine, In-Place Pause/Resume, Watchdog + WebAudio Fallback,
// iOS Control Center / MediaSession Sync, Blind-Operation Controls, Dynamic Merge & Normalization

import {
  SPEED_STEPS,
  state,
  formatIdx,
  formatTimeSec,
  showGiantHud,
  copyTextSynchronously,
  logKeyEvent,
  savePackToDB,
  showPackSaveFailedHud,
  savePrefsSync
} from './state-storage.js';

import {
  getAudioContext,
  createToneWavDataUri,
  createSilentWavDataUri,
  dataUriToBlobUrl,
  decodeWavDataUriToPCM,
  unlockiOSAudioAndSpeechSynchronously,
  mergeAudioPairPCM,
  normalizePackItemsPCM
} from './audio-processor.js';

// ==========================================
// INTERNAL PLAYBACK TIMERS & CALLBACK BRIDGE
// ==========================================
let gapTimerId = null;
let progressRafId = null;
let watchdogIntervalId = null;
let lastProgressAdvanceMs = 0;
let lastObservedAudioTime = 0;
let watchdogRetryCount = 0;
let playbackAttemptId = 0;
let recoveryInProgress = false;
let systemHooksBound = false;

// Ignore windows so our own programmatic pause()/play() calls are never mistaken for iOS Control Center actions
let ignoreMasterPauseUntil = 0;
let ignoreMasterPlayUntil = 0;
let ignoreKeepAlivePauseUntil = 0;
let ignoreKeepAlivePlayUntil = 0;

let activeBlobUrl = null;
let loadedAudioDataUri = null;

let activeWebAudioSource = null;
let activeWebAudioCtx = null;
let webAudioStartTimestamp = 0;
let webAudioStartOffset = 0;
let webAudioDuration = 0;

let playerCallbacks = {
  onRenderMainStage: () => {},
  onUpdatePlayPauseUI: () => {}
};

export function registerPlayerCallbacks(cbs = {}) {
  if (typeof cbs.onRenderMainStage === 'function') {
    playerCallbacks.onRenderMainStage = cbs.onRenderMainStage;
  }
  if (typeof cbs.onUpdatePlayPauseUI === 'function') {
    playerCallbacks.onUpdatePlayPauseUI = cbs.onUpdatePlayPauseUI;
  }
}

// ==========================================
// MEDIA SESSION (iOS CONTROL CENTER / CAR BLUETOOTH)
// ==========================================
function setMediaSessionPlaybackState(playbackState) {
  try {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = playbackState;
    }
  } catch (e) {}
}

function updateMediaSessionMetadata() {
  try {
    if (!('mediaSession' in navigator) || typeof window.MediaMetadata === 'undefined') return;
    const pack = state.currentPack;
    const item = pack?.items?.[state.currentIndex];
    if (!pack || !item) return;
    const cleanEn = String(item.en || '').replace(/^\d+[\.\)、\-\s]+/, '').trim();
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: `#${formatIdx(state.currentIndex + 1)}/${formatIdx(pack.items.length)} ${cleanEn}`,
      artist: pack.name || '英文跟讀播放器',
      album: `語速 ${(SPEED_STEPS[state.speedIndex] || 1.0).toFixed(2)}x`
    });
  } catch (e) {}
}

function registerMediaSessionHandlers() {
  try {
    if (!('mediaSession' in navigator)) return;
    const safeSet = (action, handler) => {
      try {
        navigator.mediaSession.setActionHandler(action, (details) => {
          // Remotes that send media keys arrive here, never as keydown; trace them so that shows up
          logKeyEvent(`媒體鍵 ${action}（來自系統：控制中心、耳機或遙控器的媒體按鍵）`);
          handler(details);
        });
      } catch (e) {}
    };
    safeSet('play', () => {
      if (!state.isPlaying) {
        const resumeFrom = state.pausedOffsetSec || 0;
        playCurrentSentenceClip(resumeFrom > 0.08, resumeFrom);
      }
    });
    safeSet('pause', () => {
      if (state.isPlaying) {
        pausePlaybackInPlace('控制中心暫停');
      }
    });
    safeSet('stop', () => {
      if (state.isPlaying) {
        pausePlaybackInPlace('系統停止');
      }
    });
    safeSet('previoustrack', () => {
      actionPrevSentence();
    });
    safeSet('nexttrack', () => {
      actionNextSentence();
    });
  } catch (e) {}
}

// ==========================================
// BLOB URL & GAP KEEP-ALIVE HELPERS
// ==========================================
function ensureMasterAudioSource(audio, targetDataUri) {
  if (loadedAudioDataUri === targetDataUri && activeBlobUrl && audio.src === activeBlobUrl) {
    return false; // Already loaded
  }
  ignoreMasterPauseUntil = Date.now() + 350;
  if (activeBlobUrl && activeBlobUrl.startsWith('blob:')) {
    try { URL.revokeObjectURL(activeBlobUrl); } catch (e) {}
  }
  activeBlobUrl = dataUriToBlobUrl(targetDataUri);
  loadedAudioDataUri = targetDataUri;
  audio.src = activeBlobUrl;
  return true; // Newly assigned
}

function startGapKeepAlive() {
  try {
    const ka = document.getElementById('keepAliveAudio');
    if (!ka) return;
    if (!ka.src) ka.src = createSilentWavDataUri(1.0);
    if (ka.paused) {
      ignoreKeepAlivePlayUntil = Date.now() + 350;
      ka.play().catch(() => {});
    }
  } catch (e) {}
}

function stopGapKeepAlive() {
  try {
    const ka = document.getElementById('keepAliveAudio');
    if (ka && !ka.paused) {
      ignoreKeepAlivePauseUntil = Date.now() + 350;
      ka.pause();
    }
  } catch (e) {}
}

// ==========================================
// CORE PLAYBACK ENGINE & WATCHDOG
// ==========================================
export function stopAllAudioTimers() {
  if (gapTimerId) {
    clearTimeout(gapTimerId);
    gapTimerId = null;
  }
  if (progressRafId) {
    cancelAnimationFrame(progressRafId);
    progressRafId = null;
  }
  if (activeWebAudioSource) {
    try { activeWebAudioSource.onended = null; } catch (e) {}
    try { activeWebAudioSource.stop(); } catch (e) {}
    activeWebAudioSource = null;
    activeWebAudioCtx = null;
  }
}

export function pausePlaybackInPlace(reasonLabel = '原地暫停') {
  playbackAttemptId++;
  recoveryInProgress = false;
  const wasInGap = state.isInGap;
  const audio = document.getElementById('masterAudio');

  if (wasInGap) {
    state.pausedOffsetSec = 0;
  } else if (activeWebAudioSource && activeWebAudioCtx && activeWebAudioCtx.state === 'running') {
    const elapsed = (activeWebAudioCtx.currentTime - webAudioStartTimestamp) * (SPEED_STEPS[state.speedIndex] || 1.0);
    state.pausedOffsetSec = Math.min(webAudioDuration, webAudioStartOffset + elapsed);
  } else if (audio && !audio.paused && audio.currentTime > 0) {
    state.pausedOffsetSec = audio.currentTime;
  } else if (audio && audio.currentTime > 0 && !audio.ended) {
    state.pausedOffsetSec = audio.currentTime;
  } else if (lastObservedAudioTime > 0) {
    state.pausedOffsetSec = lastObservedAudioTime;
  }

  stopAllAudioTimers();
  stopGapKeepAlive();
  state.isPlaying = false;
  state.isInGap = false;

  if (audio) {
    ignoreMasterPauseUntil = Date.now() + 350;
    try { audio.pause(); } catch (e) {}
  }
  try {
    if ('speechSynthesis' in window && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  } catch (e) {}

  setMediaSessionPlaybackState('paused');
  playerCallbacks.onUpdatePlayPauseUI(`${reasonLabel} (${formatTimeSec(state.pausedOffsetSec)})`);
}

function getLivePlaybackTimeSec() {
  const speed = SPEED_STEPS[state.speedIndex] || 1.0;
  if (activeWebAudioSource && activeWebAudioCtx) {
    if (activeWebAudioCtx.state !== 'running') {
      return webAudioStartOffset;
    }
    return Math.max(0, webAudioStartOffset + (activeWebAudioCtx.currentTime - webAudioStartTimestamp) * speed);
  }
  const audio = document.getElementById('masterAudio');
  return audio ? (Number(audio.currentTime) || 0) : 0;
}

function renderProgressBarAt(curSec, totalDur) {
  const pct = Math.min(100, Math.max(0, (curSec / Math.max(0.2, totalDur)) * 100));
  const timeCurEl = document.getElementById('timeCurrent');
  const fillEl = document.getElementById('progressBarFill');
  if (timeCurEl) timeCurEl.textContent = formatTimeSec(curSec);
  if (fillEl) fillEl.style.width = `${pct}%`;
}

export function startProgressLoop() {
  if (progressRafId) cancelAnimationFrame(progressRafId);
  const item = state.currentPack?.items?.[state.currentIndex];
  const totalDur = Number(item?.durationSec) || 2.8;

  const step = () => {
    if (!state.isPlaying || state.isInGap) return;
    const cur = getLivePlaybackTimeSec();
    if (Math.abs(cur - lastObservedAudioTime) > 0.02) {
      lastObservedAudioTime = cur;
      lastProgressAdvanceMs = Date.now();
      watchdogRetryCount = 0;
    }
    renderProgressBarAt(cur, totalDur);
    progressRafId = requestAnimationFrame(step);
  };
  progressRafId = requestAnimationFrame(step);
}

export function speakDemoSentenceIfEnabled(item, startOffsetSec = 0) {
  if (!state.currentPack?.isDemoTTS) return;
  try {
    if ('speechSynthesis' in window && window.speechSynthesis && startOffsetSec < 0.35) {
      window.speechSynthesis.cancel();
      const cleanEn = String(item.en || '').replace(/^\d+[\.\)、\-\s]+/, '').trim();
      const utter = new SpeechSynthesisUtterance(cleanEn);
      utter.lang = 'en-US';
      utter.rate = SPEED_STEPS[state.speedIndex] || 1.0;
      window.speechSynthesis.speak(utter);
    }
  } catch (e) {}
}

export async function startWebAudioMainPlaybackFallback(item, offsetSec = 0, attemptId = playbackAttemptId) {
  const audio = document.getElementById('masterAudio');
  if (audio) {
    ignoreMasterPauseUntil = Date.now() + 350;
    try { audio.pause(); } catch (e) {}
  }
  stopGapKeepAlive();

  const pcm = decodeWavDataUriToPCM(item.audioDataUri);
  const ctx = getAudioContext();
  if (!pcm || !ctx) {
    return false;
  }

  // Ensure AudioContext is genuinely running before starting (prevents frozen 00:00.0 state on iOS)
  if (ctx.state !== 'running') {
    try {
      await Promise.race([
        ctx.resume(),
        new Promise((resolve) => setTimeout(resolve, 450))
      ]);
    } catch (e) {}
  }

  if (attemptId !== playbackAttemptId || !state.isPlaying || state.isInGap) {
    return false;
  }
  if (ctx.state !== 'running') {
    return false;
  }

  if (activeWebAudioSource) {
    try { activeWebAudioSource.onended = null; } catch (e) {}
    try { activeWebAudioSource.stop(); } catch (e) {}
  }

  const buf = ctx.createBuffer(1, pcm.samples.length, pcm.sampleRate);
  buf.getChannelData(0).set(pcm.samples);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const speed = SPEED_STEPS[state.speedIndex] || 1.0;
  src.playbackRate.value = speed;
  src.connect(ctx.destination);

  activeWebAudioCtx = ctx;
  webAudioStartTimestamp = ctx.currentTime;
  webAudioStartOffset = Math.min(Math.max(0, buf.duration - 0.05), Math.max(0, offsetSec));
  webAudioDuration = buf.duration;
  activeWebAudioSource = src;
  lastObservedAudioTime = webAudioStartOffset;
  lastProgressAdvanceMs = Date.now();

  src.onended = () => {
    if (activeWebAudioSource === src && attemptId === playbackAttemptId && state.isPlaying && !state.isInGap) {
      activeWebAudioSource = null;
      activeWebAudioCtx = null;
      handleClipEnded();
    }
  };
  src.start(0, webAudioStartOffset);
  setMediaSessionPlaybackState('playing');
  startProgressLoop();
  return true;
}

function playMasterAudioAtOffset(audio, targetOffset, attemptId, forceReload = false) {
  const applySeekAndPlay = () => {
    if (attemptId !== playbackAttemptId || !state.isPlaying || state.isInGap) return;
    try {
      audio.currentTime = targetOffset;
    } catch (e) {}
    ignoreMasterPlayUntil = Date.now() + 350;
    const playPromise = audio.play();
    if (playPromise && playPromise.catch) {
      playPromise.catch((err) => {
        if (attemptId !== playbackAttemptId || !state.isPlaying || state.isInGap) return;
        if (err && err.name === 'AbortError') return;
        recoverStalledPlayback(attemptId, `play() rejected: ${err?.name || 'error'}`);
      });
    }
  };

  if (forceReload) {
    ignoreMasterPauseUntil = Date.now() + 350;
    try { audio.load(); } catch (e) {}
  }

  if (!forceReload && audio.readyState >= 1) {
    applySeekAndPlay();
  } else {
    let fired = false;
    const onReady = () => {
      if (fired) return;
      fired = true;
      audio.removeEventListener('loadedmetadata', onReady);
      audio.removeEventListener('canplay', onReady);
      applySeekAndPlay();
    };
    audio.addEventListener('loadedmetadata', onReady, { once: true });
    audio.addEventListener('canplay', onReady, { once: true });
    setTimeout(() => {
      if (!fired && attemptId === playbackAttemptId && state.isPlaying && !state.isInGap) {
        onReady();
      }
    }, 120);
  }
}

async function recoverStalledPlayback(attemptId, reason = 'stalled') {
  if (recoveryInProgress) return;
  if (attemptId !== playbackAttemptId || !state.isPlaying || state.isInGap) return;

  const item = state.currentPack?.items?.[state.currentIndex];
  const audio = document.getElementById('masterAudio');
  if (!item || !audio) return;

  recoveryInProgress = true;
  const resumeAt = Math.max(0, lastObservedAudioTime || state.pausedOffsetSec || 0);

  try {
    if (watchdogRetryCount === 0) {
      // Stage 1: Clean reload on masterAudio (keeps iOS background / lock-screen audio alive)
      watchdogRetryCount = 1;
      lastProgressAdvanceMs = Date.now();
      if (typeof window.logDiag === 'function') {
        window.logDiag('WARN', `播放自癒 #1 (${reason})：重新載入主音軌自 ${resumeAt.toFixed(1)}s 續播`);
      }
      stopAllAudioTimers();
      stopGapKeepAlive();
      ignoreMasterPauseUntil = Date.now() + 350;
      try { audio.pause(); } catch (e) {}

      const targetUri = item.audioDataUri || createToneWavDataUri(item.durationSec || 2.8);
      if (activeBlobUrl && activeBlobUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(activeBlobUrl); } catch (e) {}
      }
      activeBlobUrl = null;
      loadedAudioDataUri = null;
      ensureMasterAudioSource(audio, targetUri);
      audio.muted = Boolean(state.currentPack.isDemoTTS && state.demoVoiceMode === 'tts_only');
      audio.playbackRate = SPEED_STEPS[state.speedIndex] || 1.0;
      playMasterAudioAtOffset(audio, resumeAt, attemptId, true);
      startProgressLoop();
    } else if (watchdogRetryCount === 1) {
      // Stage 2: Verified WebAudio fallback (only if AudioContext can actually run)
      watchdogRetryCount = 2;
      lastProgressAdvanceMs = Date.now();
      if (typeof window.logDiag === 'function') {
        window.logDiag('WARN', `播放自癒 #2 (${reason})：嘗試切換 WebAudio 備援通道`);
      }
      const ok = await startWebAudioMainPlaybackFallback(item, resumeAt, attemptId);
      if (!ok && attemptId === playbackAttemptId && state.isPlaying && !state.isInGap) {
        pausePlaybackInPlace('系統暫停，點播放續播');
        showGiantHud('⏸️', '系統暫停了音訊', '點擊播放鍵即可原地繼續', 'border-amber-400/90');
      }
    } else {
      // Stage 3: Both channels blocked by OS
      if (typeof window.logDiag === 'function') {
        window.logDiag('WARN', `播放自癒終止 (${reason})：音訊通道遭系統中斷，自動轉為原地暫停`);
      }
      pausePlaybackInPlace('系統暫停，點播放續播');
      showGiantHud('⏸️', '系統中斷音訊', '點擊播放鍵即可原地繼續', 'border-amber-400/90');
    }
  } finally {
    recoveryInProgress = false;
  }
}

export function playCurrentSentenceClip(isFastSameSentenceRepeat = false, resumeOffsetSec = 0) {
  if (!state.currentPack || !state.currentPack.items.length) return;
  const attemptId = ++playbackAttemptId;
  recoveryInProgress = false;
  watchdogRetryCount = 0;

  stopAllAudioTimers();
  stopGapKeepAlive();

  state.isPlaying = true;
  state.isInGap = false;
  const item = state.currentPack.items[state.currentIndex];
  const audio = document.getElementById('masterAudio');
  const speed = SPEED_STEPS[state.speedIndex] || 1.0;

  playerCallbacks.onRenderMainStage();
  updateMediaSessionMetadata();
  setMediaSessionPlaybackState('playing');

  const targetOffset = Math.max(0, Number(resumeOffsetSec) || 0);
  state.pausedOffsetSec = 0;
  lastProgressAdvanceMs = Date.now();
  lastObservedAudioTime = targetOffset;
  renderProgressBarAt(targetOffset, Number(item.durationSec) || 2.8);

  speakDemoSentenceIfEnabled(item, targetOffset);

  if (!audio) return;
  audio.muted = Boolean(state.currentPack.isDemoTTS && state.demoVoiceMode === 'tts_only');
  audio.playbackRate = speed;

  const targetUri = item.audioDataUri || createToneWavDataUri(item.durationSec || 2.8);
  const srcChanged = ensureMasterAudioSource(audio, targetUri);

  // Same-sentence zero-reload fast repeat or in-place resume when blob is already ready
  if (isFastSameSentenceRepeat && !srcChanged && audio.readyState >= 2) {
    playMasterAudioAtOffset(audio, targetOffset, attemptId, false);
    startProgressLoop();
    return;
  }

  playMasterAudioAtOffset(audio, targetOffset, attemptId, srcChanged);
  startProgressLoop();
}

export function handleClipEnded() {
  if (!state.isPlaying || state.isInGap) return;
  const endedAttemptId = playbackAttemptId;
  stopAllAudioTimers();
  state.pausedOffsetSec = 0;
  watchdogRetryCount = 0;

  const item = state.currentPack?.items?.[state.currentIndex];
  const dur = Number(item?.durationSec) || 2.8;
  renderProgressBarAt(dur, dur);

  let gapSec = 0;
  if (state.gapMode === 'auto') gapSec = Math.max(1.0, Math.min(8.0, dur));
  else gapSec = Number(state.gapMode) || 0;

  const proceedNextStep = () => {
    if (!state.isPlaying || endedAttemptId !== playbackAttemptId) return;
    state.isInGap = false;
    stopGapKeepAlive();
    const isInf = state.repeatTarget >= 999;
    if (isInf || state.repeatCountCurrent < state.repeatTarget) {
      state.repeatCountCurrent++;
      playCurrentSentenceClip(true, 0);
    } else {
      state.repeatCountCurrent = 1;
      state.currentIndex = (state.currentIndex + 1) % state.currentPack.items.length;
      savePrefsSync();
      playCurrentSentenceClip(false, 0);
    }
  };

  if (gapSec > 0.05) {
    state.isInGap = true;
    // Play pure silent keep-alive ONLY during inter-sentence gap while masterAudio is idle
    startGapKeepAlive();
    playerCallbacks.onUpdatePlayPauseUI(`跟讀留白 (${gapSec.toFixed(0)}秒)...`);
    gapTimerId = setTimeout(proceedNextStep, gapSec * 1000);
  } else {
    proceedNextStep();
  }
}

export function setupWatchdogTimer() {
  if (!systemHooksBound) {
    systemHooksBound = true;
    registerMediaSessionHandlers();

    const audio = document.getElementById('masterAudio');
    if (audio) {
      audio.addEventListener('error', () => {
        if (state.isPlaying && !state.isInGap && !activeWebAudioSource) {
          recoverStalledPlayback(playbackAttemptId, 'masterAudio error event');
        }
      });

      // Respect external pause (iOS Control Center, Lock Screen, AirPods removal, phone call)
      audio.addEventListener('pause', () => {
        if (!state.isPlaying || state.isInGap || activeWebAudioSource) return;
        if (Date.now() < ignoreMasterPauseUntil) return;
        if (audio.ended) return;
        if (Number.isFinite(audio.duration) && audio.duration > 0 && audio.currentTime >= audio.duration - 0.1) {
          return;
        }
        pausePlaybackInPlace('系統面板暫停');
      });

      // Respect external resume directly on masterAudio from iOS Control Center
      audio.addEventListener('play', () => {
        if (state.isPlaying) return;
        if (Date.now() < ignoreMasterPlayUntil) return;
        if (!state.currentPack || !state.currentPack.items.length) return;

        state.isPlaying = true;
        state.isInGap = false;
        state.pausedOffsetSec = 0;
        watchdogRetryCount = 0;
        lastObservedAudioTime = Number(audio.currentTime) || 0;
        lastProgressAdvanceMs = Date.now();
        updateMediaSessionMetadata();
        setMediaSessionPlaybackState('playing');
        playerCallbacks.onUpdatePlayPauseUI();
        startProgressLoop();
      });
    }

    const ka = document.getElementById('keepAliveAudio');
    if (ka) {
      // Respect external pause tapped in iOS Control Center during inter-sentence gap
      ka.addEventListener('pause', () => {
        if (!state.isPlaying || !state.isInGap) return;
        if (Date.now() < ignoreKeepAlivePauseUntil) return;
        pausePlaybackInPlace('系統面板暫停');
      });

      // If user taps Play in Control Center while paused after a gap, hand off cleanly to masterAudio
      ka.addEventListener('play', () => {
        if (state.isPlaying) return;
        if (Date.now() < ignoreKeepAlivePlayUntil) return;
        ignoreKeepAlivePauseUntil = Date.now() + 350;
        try { ka.pause(); } catch (e) {}
        if (state.currentPack && state.currentPack.items.length) {
          const resumeFrom = state.pausedOffsetSec || 0;
          playCurrentSentenceClip(resumeFrom > 0.08, resumeFrom);
        }
      });
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.isPlaying && !state.isInGap) {
        const cur = getLivePlaybackTimeSec();
        if (Math.abs(cur - lastObservedAudioTime) > 0.02) {
          lastObservedAudioTime = cur;
          lastProgressAdvanceMs = Date.now();
        }
        startProgressLoop();
      }
    });
  }

  if (watchdogIntervalId) clearInterval(watchdogIntervalId);
  watchdogIntervalId = setInterval(() => {
    if (!state.isPlaying || state.isInGap || recoveryInProgress) return;
    const item = state.currentPack?.items?.[state.currentIndex];
    if (!item) return;

    const audio = document.getElementById('masterAudio');
    const totalDur = Number(item.durationSec) || 2.8;

    // 1. Catch missed 'ended' event on HTMLAudioElement
    if (!activeWebAudioSource && audio && audio.ended) {
      handleClipEnded();
      return;
    }

    // 2. Read live audio clock directly (works even when screen is off & rAF is paused)
    const liveCur = getLivePlaybackTimeSec();
    if (Math.abs(liveCur - lastObservedAudioTime) > 0.02) {
      lastObservedAudioTime = liveCur;
      lastProgressAdvanceMs = Date.now();
      watchdogRetryCount = 0;
      renderProgressBarAt(liveCur, totalDur);
      return;
    }

    const stalledMs = Date.now() - lastProgressAdvanceMs;

    // 3. Catch near-end freeze where iOS stops 0.1s before end without firing 'ended'
    if (liveCur > 0.2 && liveCur >= totalDur - 0.15 && stalledMs > 900) {
      handleClipEnded();
      return;
    }

    // 4. Trigger progressive recovery when genuinely stalled (including stalled WebAudio)
    const stallThresholdMs = activeWebAudioSource ? 1500 : 1200;
    if (stalledMs > stallThresholdMs) {
      recoverStalledPlayback(playbackAttemptId, `stalled ${stalledMs}ms at ${liveCur.toFixed(1)}s`);
    }
  }, 400);
}

// ==========================================
// PLAYER ACTIONS (BLIND OPERATION CONTROLS)
// ==========================================
export function actionPrevSentence() {
  unlockiOSAudioAndSpeechSynchronously();
  if (!state.currentPack || !state.currentPack.items.length) return;
  const total = state.currentPack.items.length;
  state.currentIndex = (state.currentIndex - 1 + total) % total;
  state.repeatCountCurrent = 1;
  state.pausedOffsetSec = 0;
  document.getElementById('aiExplainDrawer')?.classList.add('hidden');
  savePrefsSync();
  showGiantHud('⏮️', `上一句 (#${formatIdx(state.currentIndex + 1)})`, state.currentPack.items[state.currentIndex].en);
  playCurrentSentenceClip(false, 0);
}

export function actionRestartCurrentSentence() {
  unlockiOSAudioAndSpeechSynchronously();
  if (!state.currentPack || !state.currentPack.items.length) return;
  state.repeatCountCurrent = 1;
  state.pausedOffsetSec = 0;
  const timeCurEl = document.getElementById('timeCurrent');
  const fillEl = document.getElementById('progressBarFill');
  if (timeCurEl) timeCurEl.textContent = '00:00.0';
  if (fillEl) fillEl.style.width = '0%';
  showGiantHud(
    '🔄',
    '回到這句開頭',
    `第 #${formatIdx(state.currentIndex + 1)} 句 (重置為 1/${state.repeatTarget >= 999 ? '∞' : state.repeatTarget})`,
    'border-emerald-400/90'
  );
  playCurrentSentenceClip(true, 0);
}

export function actionTogglePlayPause() {
  unlockiOSAudioAndSpeechSynchronously();
  if (state.isPlaying) {
    pausePlaybackInPlace('已暫停');
    showGiantHud('⏸️', '原地暫停', `停於 ${formatTimeSec(state.pausedOffsetSec)} (再按繼續播)`, 'border-amber-400/90');
  } else {
    const resumeFrom = state.pausedOffsetSec || 0;
    showGiantHud('▶️', resumeFrom > 0.08 ? '原地繼續播放' : '開始播放', `從 ${formatTimeSec(resumeFrom)} 接續`, 'border-sky-400/90');
    playCurrentSentenceClip(resumeFrom > 0.08, resumeFrom);
  }
}

export function actionNextSentence() {
  unlockiOSAudioAndSpeechSynchronously();
  if (!state.currentPack || !state.currentPack.items.length) return;
  const total = state.currentPack.items.length;
  state.currentIndex = (state.currentIndex + 1) % total;
  state.repeatCountCurrent = 1;
  state.pausedOffsetSec = 0;
  document.getElementById('aiExplainDrawer')?.classList.add('hidden');
  savePrefsSync();
  showGiantHud('⏭️', `下一句 (#${formatIdx(state.currentIndex + 1)})`, state.currentPack.items[state.currentIndex].en);
  playCurrentSentenceClip(false, 0);
}

export function actionCycleSpeed() {
  unlockiOSAudioAndSpeechSynchronously();
  const prevSpeed = SPEED_STEPS[state.speedIndex] || 1.0;
  state.speedIndex = (state.speedIndex + 1) % SPEED_STEPS.length;
  const speed = SPEED_STEPS[state.speedIndex];
  const audio = document.getElementById('masterAudio');
  if (audio) audio.playbackRate = speed;
  if (activeWebAudioSource && activeWebAudioCtx) {
    webAudioStartOffset += (activeWebAudioCtx.currentTime - webAudioStartTimestamp) * prevSpeed;
    webAudioStartTimestamp = activeWebAudioCtx.currentTime;
    activeWebAudioSource.playbackRate.value = speed;
  }
  savePrefsSync();
  updateMediaSessionMetadata();
  playerCallbacks.onRenderMainStage();
  showGiantHud('⚡', `語速 ${speed.toFixed(2)}x`, '長按播放鍵或按調速鍵可循環切換', 'border-amber-400/90');
}

export function actionToggleInfiniteLoop() {
  if (state.repeatTarget >= 999) {
    state.repeatTarget = state.previousFiniteRepeatTarget || 2;
    showGiantHud('🔁', `恢復每句重複 ${state.repeatTarget} 次`, '已關閉無限單句循環', 'border-emerald-400/90');
  } else {
    state.previousFiniteRepeatTarget = state.repeatTarget;
    state.repeatTarget = 999;
    showGiantHud('♾️', '開啟無限單句循環', `再按一次可回到 ${state.previousFiniteRepeatTarget} 次`, 'border-amber-400/90');
  }
  savePrefsSync();
  playerCallbacks.onRenderMainStage();
}

export function actionResetToFirstSentence() {
  unlockiOSAudioAndSpeechSynchronously();
  if (!state.currentPack || !state.currentPack.items.length) return;
  state.currentIndex = 0;
  state.repeatCountCurrent = 1;
  state.pausedOffsetSec = 0;
  savePrefsSync();
  playerCallbacks.onRenderMainStage();
  showGiantHud('⏮️', '已回到第 #01 句', state.currentPack.items[0].en, 'border-sky-400/90');
  if (state.isPlaying) playCurrentSentenceClip(false, 0);
}

// ==========================================
// DYNAMIC MERGE, VOLUME NORMALIZATION & COPY
// ==========================================
export async function actionMergeWithNextSentence() {
  unlockiOSAudioAndSpeechSynchronously();
  if (!state.currentPack || state.currentPack.items.length < 2) {
    showGiantHud('⚠️', '無法合併', '教材內只剩 1 句，無下一句可合併', 'border-rose-400/90');
    return;
  }
  const idx = state.currentIndex;
  if (idx >= state.currentPack.items.length - 1) {
    showGiantHud('⚠️', '已是最後一句', '最後一句無法再往後合併', 'border-rose-400/90');
    return;
  }

  // Save deep snapshot for 1-click Undo
  state.undoMergeSnapshot = {
    packId: state.currentPack.id,
    currentIndex: state.currentIndex,
    itemsClone: JSON.parse(JSON.stringify(state.currentPack.items))
  };

  const curItem = state.currentPack.items[idx];
  const nextItem = state.currentPack.items[idx + 1];

  const merged = mergeAudioPairPCM(
    curItem.audioDataUri,
    nextItem.audioDataUri,
    curItem.durationSec,
    nextItem.durationSec
  );

  if (state.mergeSubMode === 'audio_only_shift') {
    curItem.audioDataUri = merged.audioDataUri;
    curItem.durationSec = merged.durationSec;
    for (let i = idx + 1; i < state.currentPack.items.length - 1; i++) {
      state.currentPack.items[i].audioDataUri = state.currentPack.items[i + 1].audioDataUri;
      state.currentPack.items[i].durationSec = state.currentPack.items[i + 1].durationSec;
    }
    state.currentPack.items.pop();
  } else {
    curItem.audioDataUri = merged.audioDataUri;
    curItem.durationSec = merged.durationSec;
    const cleanNextEn = String(nextItem.en || '').replace(/^\d+[\.\)、\-\s]+/, '').trim();
    curItem.en = `${curItem.en} ${cleanNextEn}`.trim();
    if (nextItem.zh) {
      curItem.zh = `${curItem.zh || ''} ${nextItem.zh}`.trim();
    }
    state.currentPack.items.splice(idx + 1, 1);
  }

  state.repeatCountCurrent = 1;
  state.pausedOffsetSec = 0;
  const saved = await savePackToDB(state.currentPack);
  savePrefsSync();
  playerCallbacks.onRenderMainStage();
  if (saved) {
    showGiantHud('🔗', '已合併下句並重播', `新長度 ${merged.durationSec.toFixed(1)}s (可點 ↩️ 復原)`, 'border-emerald-400/90');
  } else {
    showPackSaveFailedHud();
  }
  playCurrentSentenceClip(false, 0);
}

export async function actionUndoMergeSentence() {
  if (!state.undoMergeSnapshot || !state.currentPack) return;
  // A snapshot only ever applies to the pack it was taken from; never restore it onto another pack
  if (state.undoMergeSnapshot.packId !== state.currentPack.id) {
    state.undoMergeSnapshot = null;
    playerCallbacks.onRenderMainStage();
    return;
  }
  state.currentPack.items = state.undoMergeSnapshot.itemsClone;
  state.currentIndex = state.undoMergeSnapshot.currentIndex;
  state.undoMergeSnapshot = null;
  state.repeatCountCurrent = 1;
  state.pausedOffsetSec = 0;
  const saved = await savePackToDB(state.currentPack);
  savePrefsSync();
  playerCallbacks.onRenderMainStage();
  if (saved) {
    showGiantHud('↩️', '已復原合併', `恢復為 ${state.currentPack.items.length} 句`, 'border-sky-400/90');
  } else {
    showPackSaveFailedHud();
  }
}

export async function actionNormalizeCurrentPackVolume() {
  if (!state.currentPack || !state.currentPack.items.length) return;
  const count = normalizePackItemsPCM(state.currentPack.items);
  const saved = await savePackToDB(state.currentPack);
  playerCallbacks.onRenderMainStage();
  if (saved) {
    showGiantHud('🎚️', `已平衡 ${count} 句音量`, '統一校準至 -16dBFS 人聲響度並防爆音', 'border-amber-400/90');
  } else {
    showPackSaveFailedHud();
  }
}

export function triggerCopyCurrentSentence() {
  if (!state.currentPack || !state.currentPack.items.length) return;
  if (state.isPlaying) {
    pausePlaybackInPlace('複製暫停');
  }
  const item = state.currentPack.items[state.currentIndex];
  const cleanEn = String(item.en || '').replace(/^\d+[\.\)、\-\s]+/, '').trim();
  copyTextSynchronously(cleanEn);
  showGiantHud('📋', '已複製乾淨英文並原地暫停', cleanEn, 'border-sky-400/90');
}

// EOF: js/player-engine.js