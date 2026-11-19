// Layer 2: Playback Engine, In-Place Pause/Resume, Watchdog + WebAudio Fallback,
// Blind-Operation Controls, Dynamic Merge & Pack Volume Normalization

import {
  SPEED_STEPS,
  state,
  formatIdx,
  formatTimeSec,
  showGiantHud,
  copyTextSynchronously,
  savePackToDB,
  savePrefsSync
} from './state-storage.js';

import {
  getAudioContext,
  createToneWavDataUri,
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
    try { activeWebAudioSource.stop(); } catch (e) {}
    activeWebAudioSource = null;
    activeWebAudioCtx = null;
  }
}

export function pausePlaybackInPlace(reasonLabel = '原地暫停') {
  const audio = document.getElementById('masterAudio');
  if (audio && !audio.paused && audio.currentTime > 0) {
    state.pausedOffsetSec = audio.currentTime;
  } else if (activeWebAudioSource && activeWebAudioCtx) {
    const elapsed = (activeWebAudioCtx.currentTime - webAudioStartTimestamp) * (SPEED_STEPS[state.speedIndex] || 1.0);
    state.pausedOffsetSec = Math.min(webAudioDuration, webAudioStartOffset + elapsed);
  }
  stopAllAudioTimers();
  state.isPlaying = false;
  state.isInGap = false;
  if (audio) {
    try { audio.pause(); } catch (e) {}
  }
  try {
    if ('speechSynthesis' in window && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  } catch (e) {}
  playerCallbacks.onUpdatePlayPauseUI(`${reasonLabel} (${formatTimeSec(state.pausedOffsetSec)})`);
}

export function startProgressLoop() {
  if (progressRafId) cancelAnimationFrame(progressRafId);
  const audio = document.getElementById('masterAudio');
  const item = state.currentPack?.items?.[state.currentIndex];
  const totalDur = Number(item?.durationSec) || 2.8;

  const step = () => {
    if (!state.isPlaying) return;
    let cur = 0;
    if (activeWebAudioSource && activeWebAudioCtx) {
      cur = webAudioStartOffset + (activeWebAudioCtx.currentTime - webAudioStartTimestamp) * (SPEED_STEPS[state.speedIndex] || 1.0);
    } else if (audio) {
      cur = audio.currentTime || 0;
    }
    if (Math.abs(cur - lastObservedAudioTime) > 0.02) {
      lastObservedAudioTime = cur;
      lastProgressAdvanceMs = Date.now();
    }
    const pct = Math.min(100, Math.max(0, (cur / Math.max(0.2, totalDur)) * 100));
    const timeCurEl = document.getElementById('timeCurrent');
    const fillEl = document.getElementById('progressBarFill');
    if (timeCurEl) timeCurEl.textContent = formatTimeSec(cur);
    if (fillEl) fillEl.style.width = `${pct}%`;
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

export function startWebAudioMainPlaybackFallback(item, offsetSec = 0) {
  const pcm = decodeWavDataUriToPCM(item.audioDataUri);
  const ctx = getAudioContext();
  if (!pcm || !ctx) {
    handleClipEnded();
    return;
  }
  if (activeWebAudioSource) {
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
  lastProgressAdvanceMs = Date.now();

  src.onended = () => {
    if (activeWebAudioSource === src && state.isPlaying && !state.isInGap) {
      activeWebAudioSource = null;
      activeWebAudioCtx = null;
      handleClipEnded();
    }
  };
  src.start(0, webAudioStartOffset);
  startProgressLoop();
}

export function playCurrentSentenceClip(isFastSameSentenceRepeat = false, resumeOffsetSec = 0) {
  if (!state.currentPack || !state.currentPack.items.length) return;
  stopAllAudioTimers();
  state.isPlaying = true;
  state.isInGap = false;
  const item = state.currentPack.items[state.currentIndex];
  const audio = document.getElementById('masterAudio');
  const speed = SPEED_STEPS[state.speedIndex] || 1.0;

  playerCallbacks.onRenderMainStage();
  lastProgressAdvanceMs = Date.now();
  lastObservedAudioTime = resumeOffsetSec;

  speakDemoSentenceIfEnabled(item, resumeOffsetSec);

  if (!audio) return;
  audio.muted = Boolean(state.currentPack.isDemoTTS && state.demoVoiceMode === 'tts_only');
  audio.playbackRate = speed;

  const targetOffset = Math.max(0, Number(resumeOffsetSec) || 0);
  state.pausedOffsetSec = 0;

  // Same-sentence zero-reload fast repeat or in-place resume
  if (isFastSameSentenceRepeat && audio.src && audio.src.startsWith('data:audio')) {
    try {
      audio.currentTime = targetOffset;
      const p = audio.play();
      if (p && p.catch) {
        p.catch(() => startWebAudioMainPlaybackFallback(item, targetOffset));
      }
      startProgressLoop();
      return;
    } catch (e) {}
  }

  audio.src = item.audioDataUri || createToneWavDataUri(item.durationSec || 2.8);
  try {
    if (targetOffset > 0.05) {
      audio.currentTime = targetOffset;
    }
  } catch (e) {}

  const playPromise = audio.play();
  if (playPromise && playPromise.catch) {
    playPromise.catch(() => {
      startWebAudioMainPlaybackFallback(item, targetOffset);
    });
  }
  startProgressLoop();
}

export function handleClipEnded() {
  if (!state.isPlaying) return;
  stopAllAudioTimers();
  state.pausedOffsetSec = 0;

  const item = state.currentPack?.items?.[state.currentIndex];
  const dur = Number(item?.durationSec) || 2.8;
  const timeCurEl = document.getElementById('timeCurrent');
  const fillEl = document.getElementById('progressBarFill');
  if (timeCurEl) timeCurEl.textContent = formatTimeSec(dur);
  if (fillEl) fillEl.style.width = '100%';

  let gapSec = 0;
  if (state.gapMode === 'auto') gapSec = Math.max(1.0, Math.min(8.0, dur));
  else gapSec = Number(state.gapMode) || 0;

  const proceedNextStep = () => {
    if (!state.isPlaying) return;
    state.isInGap = false;
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
    // Ensure silent keep-alive audio remains active during inter-sentence gap on iOS Safari
    try {
      const ka = document.getElementById('keepAliveAudio');
      if (ka && ka.paused && ka.src) {
        ka.volume = 0.01;
        ka.play().catch(() => {});
      }
    } catch (e) {}
    playerCallbacks.onUpdatePlayPauseUI(`跟讀留白 (${gapSec.toFixed(0)}秒)...`);
    gapTimerId = setTimeout(proceedNextStep, gapSec * 1000);
  } else {
    proceedNextStep();
  }
}

export function setupWatchdogTimer() {
  if (watchdogIntervalId) clearInterval(watchdogIntervalId);
  watchdogIntervalId = setInterval(() => {
    if (!state.isPlaying || state.isInGap) return;
    const stalledMs = Date.now() - lastProgressAdvanceMs;
    const item = state.currentPack?.items?.[state.currentIndex];
    if (!item) return;
    if (stalledMs > 750 && !activeWebAudioSource) {
      if (typeof window.logDiag === 'function') {
        window.logDiag('WARN', `看門狗偵測到 00:00.0 卡住 (${stalledMs}ms)，自動切換 WebAudio 通道續播`);
      }
      startWebAudioMainPlaybackFallback(item, lastObservedAudioTime || state.pausedOffsetSec || 0);
    }
  }, 350);
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
    // Re-anchor WebAudio elapsed offset before changing playbackRate
    webAudioStartOffset += (activeWebAudioCtx.currentTime - webAudioStartTimestamp) * prevSpeed;
    webAudioStartTimestamp = activeWebAudioCtx.currentTime;
    activeWebAudioSource.playbackRate.value = speed;
  }
  savePrefsSync();
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
    // Keep current subtitle intact, merge audio, shift subsequent audio clips up by 1
    curItem.audioDataUri = merged.audioDataUri;
    curItem.durationSec = merged.durationSec;
    for (let i = idx + 1; i < state.currentPack.items.length - 1; i++) {
      state.currentPack.items[i].audioDataUri = state.currentPack.items[i + 1].audioDataUri;
      state.currentPack.items[i].durationSec = state.currentPack.items[i + 1].durationSec;
    }
    state.currentPack.items.pop();
  } else {
    // Merge both audio & subtitle
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
  await savePackToDB(state.currentPack);
  savePrefsSync();
  playerCallbacks.onRenderMainStage();
  showGiantHud('🔗', '已合併下句並重播', `新長度 ${merged.durationSec.toFixed(1)}s (可點 ↩️ 復原)`, 'border-emerald-400/90');
  playCurrentSentenceClip(false, 0);
}

export async function actionUndoMergeSentence() {
  if (!state.undoMergeSnapshot || !state.currentPack) return;
  state.currentPack.items = state.undoMergeSnapshot.itemsClone;
  state.currentIndex = state.undoMergeSnapshot.currentIndex;
  state.undoMergeSnapshot = null;
  state.repeatCountCurrent = 1;
  state.pausedOffsetSec = 0;
  await savePackToDB(state.currentPack);
  savePrefsSync();
  playerCallbacks.onRenderMainStage();
  showGiantHud('↩️', '已復原合併', `恢復為 ${state.currentPack.items.length} 句`, 'border-sky-400/90');
}

export async function actionNormalizeCurrentPackVolume() {
  if (!state.currentPack || !state.currentPack.items.length) return;
  const count = normalizePackItemsPCM(state.currentPack.items);
  await savePackToDB(state.currentPack);
  playerCallbacks.onRenderMainStage();
  showGiantHud('🎚️', `已平衡 ${count} 句音量`, '統一校準至 -16dBFS 人聲響度並防爆音', 'border-amber-400/90');
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