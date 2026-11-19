// Layer 1: Audio Synthesis, WAV/PCM Processing, Active Speech RMS Normalization,
// Soft Limiter, VAD Smart Audio Splitter & ZIP/Multi-File Importer

import {
  DEFAULT_SENTENCES,
  state,
  escapeHtml,
  formatIdx,
  showGiantHud
} from './state-storage.js';

let sharedAudioCtx = null;

// ==========================================
// AUDIO CONTEXT & WAV / PCM UTILITIES
// ==========================================
export function getAudioContext() {
  if (!sharedAudioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) sharedAudioCtx = new AudioCtx();
  }
  if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

export function createToneWavDataUri(durationSec = 2.8, freqHz = 440, gain = 0.06) {
  const sampleRate = 8000;
  const numSamples = Math.max(800, Math.floor(sampleRate * durationSec));
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let env = 1.0;
    if (t < 0.08) env = t / 0.08;
    else if (t > durationSec - 0.15) env = Math.max(0, (durationSec - t) / 0.15);
    const chime = t < 0.18 ? Math.sin(2 * Math.PI * freqHz * 1.5 * t) * 0.22 : 0;
    const pad = Math.sin(2 * Math.PI * (freqHz * 0.5) * t) * gain;
    const sample = Math.max(-1, Math.min(1, (chime + pad) * env));
    view.setInt16(44 + i * 2, sample * 32767, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return 'data:audio/wav;base64,' + btoa(binary);
}

export function encodeMonoFloat32ToWavDataUri(samples, sampleRate, normMode = 'rms', globalGain = 1.0) {
  const len = samples.length;
  if (len === 0) return createToneWavDataUri(0.5, 300, 0.001);

  let gain = 1.0;
  if (normMode === 'rms') {
    // Active Speech RMS (-16 dBFS target = 0.158) ignoring silence
    let sumSq = 0;
    let activeCount = 0;
    for (let i = 0; i < len; i++) {
      const v = Math.abs(samples[i]);
      if (v > 0.008) {
        sumSq += samples[i] * samples[i];
        activeCount++;
      }
    }
    const rms = activeCount > 50 ? Math.sqrt(sumSq / activeCount) : 0.05;
    const targetRms = 0.158; // -16 dBFS
    gain = Math.min(6.0, Math.max(0.4, targetRms / Math.max(0.005, rms)));
  } else if (normMode === 'global') {
    gain = globalGain;
  }

  const buffer = new ArrayBuffer(44 + len * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + len * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, len * 2, true);

  for (let i = 0; i < len; i++) {
    let s = samples[i] * gain;
    // Soft limiter above 0.75 to prevent plosive clipping
    if (Math.abs(s) > 0.75) {
      s = Math.tanh(s);
    }
    s = Math.max(-0.98, Math.min(0.98, s));
    view.setInt16(44 + i * 2, s * 32767, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return 'data:audio/wav;base64,' + btoa(binary);
}

export function decodeWavDataUriToPCM(dataUri) {
  try {
    const commaIdx = String(dataUri || '').indexOf(',');
    if (commaIdx === -1) return null;
    const b64 = dataUri.slice(commaIdx + 1);
    const bin = atob(b64);
    const len = bin.length;
    if (len < 44) return null;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    // Verify RIFF header before decoding PCM
    if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) {
      return null;
    }
    const view = new DataView(bytes.buffer);
    const sampleRate = view.getUint32(24, true) || 16000;
    const dataOffset = 44;
    const numSamples = Math.floor((len - dataOffset) / 2);
    const floatSamples = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      floatSamples[i] = view.getInt16(dataOffset + i * 2, true) / 32768.0;
    }
    return { sampleRate, samples: floatSamples };
  } catch (e) {
    return null;
  }
}

export function createSilentWavDataUri(durationSec = 1.0) {
  const sampleRate = 8000;
  const numSamples = Math.max(800, Math.floor(sampleRate * durationSec));
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  // Near-zero dither (-90dBFS, completely inaudible) so iOS CoreAudio stays active during gaps
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(44 + i * 2, (i & 1) ? 1 : -1, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return 'data:audio/wav;base64,' + btoa(binary);
}

export function dataUriToBlobUrl(dataUri) {
  try {
    const str = String(dataUri || '');
    const match = str.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return str;
    const mime = match[1] || 'audio/wav';
    const bin = atob(match[2]);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    return URL.createObjectURL(blob);
  } catch (e) {
    return dataUri;
  }
}

export function unlockiOSAudioAndSpeechSynchronously() {
  try {
    if (navigator.audioSession && navigator.audioSession.type !== 'playback') {
      navigator.audioSession.type = 'playback';
    }
  } catch (e) {}
  try {
    const ctx = getAudioContext();
    if (ctx) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(0);
      osc.stop(ctx.currentTime + 0.02);
    }
  } catch (e) {}
  try {
    const ka = document.getElementById('keepAliveAudio');
    if (ka && !ka.src) {
      ka.src = createSilentWavDataUri(1.0);
    }
    // Unlock keepAliveAudio only once on first user gesture, then immediately pause
    // so it never collides with masterAudio on iOS Safari's single-channel audio policy
    if (ka && !ka.dataset.unlocked) {
      ka.dataset.unlocked = '1';
      const p = ka.play();
      if (p && p.then) {
        p.then(() => {
          if (!state.isInGap) ka.pause();
        }).catch(() => {
          delete ka.dataset.unlocked;
        });
      }
    }
  } catch (e) {}
}

// ==========================================
// BUILT-IN PACK, DYNAMIC MERGE & NORMALIZE PCM
// ==========================================
export function createDefaultBuiltInPack() {
  const items = DEFAULT_SENTENCES.map((s, idx) => {
    const dur = Number((2.5 + (s.en.length % 15) * 0.1).toFixed(1));
    return {
      index: idx,
      en: s.en,
      zh: s.zh,
      aiNotes: '',
      aiGrammarNote: '',
      wordNotes: {},
      durationSec: dur,
      audioDataUri: createToneWavDataUri(dur, 420 + (idx % 6) * 35, 0.05)
    };
  });
  return {
    id: 'default_pack',
    name: '預設教材：科技職場英文 20 句',
    createdAt: 1700000000000,
    audioModeLabel: 'WAV 獨立音檔',
    isDemoTTS: true,
    items
  };
}

export function mergeAudioPairPCM(dataUriA, dataUriB, fallbackDurA = 2.0, fallbackDurB = 2.0) {
  const pcmA = decodeWavDataUriToPCM(dataUriA);
  const pcmB = decodeWavDataUriToPCM(dataUriB);
  let mergedDataUri = dataUriA;
  let mergedDuration = (Number(fallbackDurA) || 2.0) + (Number(fallbackDurB) || 2.0);

  if (pcmA && pcmB) {
    const sr = pcmA.sampleRate;
    const combined = new Float32Array(pcmA.samples.length + pcmB.samples.length);
    combined.set(pcmA.samples, 0);
    combined.set(pcmB.samples, pcmA.samples.length);
    mergedDataUri = encodeMonoFloat32ToWavDataUri(combined, sr, 'rms', 1.0);
    mergedDuration = Number((combined.length / sr).toFixed(1));
  }

  return { audioDataUri: mergedDataUri, durationSec: mergedDuration };
}

export function normalizePackItemsPCM(items) {
  let count = 0;
  (items || []).forEach((it) => {
    const pcm = decodeWavDataUriToPCM(it.audioDataUri);
    if (pcm && pcm.samples.length > 0) {
      it.audioDataUri = encodeMonoFloat32ToWavDataUri(pcm.samples, pcm.sampleRate, 'rms', 1.0);
      count++;
    }
  });
  return count;
}

// ==========================================
// VAD SMART SPLITTER WORKBENCH
// ==========================================
export function precomputeAudioEnvelope(audioBuffer) {
  const raw = audioBuffer.getChannelData(0);
  const sr = audioBuffer.sampleRate;
  const hop = Math.max(1, Math.floor(sr * 0.01)); // 10ms window
  const numFrames = Math.ceil(raw.length / hop);
  const envDb = new Float32Array(numFrames);

  for (let f = 0; f < numFrames; f++) {
    const start = f * hop;
    const end = Math.min(raw.length, start + hop);
    let sum = 0;
    for (let i = start; i < end; i++) sum += raw[i] * raw[i];
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    envDb[f] = 20 * Math.log10(Math.max(1e-5, rms));
  }
  state.vadAudioBuffer = audioBuffer;
  state.vadEnvelopeDb = envDb;
  state.vadSampleRate = sr;
  state.vadHopSamples = hop;
}

export function computeVadSegmentsFromEnvelope(dbThreshold, minSilenceMs, minClipMs, padMs) {
  const env = state.vadEnvelopeDb;
  if (!env || !env.length) return [];
  const minSilenceFrames = Math.max(1, Math.round(minSilenceMs / 10));
  const minClipFrames = Math.max(1, Math.round(minClipMs / 10));
  const padFrames = Math.max(0, Math.round(padMs / 10));

  const rawSegments = [];
  let inSpeech = false;
  let segStart = 0;
  let silenceRun = 0;

  for (let i = 0; i < env.length; i++) {
    if (env[i] >= dbThreshold) {
      if (!inSpeech) {
        inSpeech = true;
        segStart = i;
      }
      silenceRun = 0;
    } else if (inSpeech) {
      silenceRun++;
      if (silenceRun >= minSilenceFrames) {
        const segEnd = i - silenceRun + 1;
        if (segEnd - segStart >= minClipFrames) {
          rawSegments.push({
            startSec: Math.max(0, (segStart - padFrames) * 0.01),
            endSec: Math.min(env.length * 0.01, (segEnd + padFrames) * 0.01)
          });
        }
        inSpeech = false;
        silenceRun = 0;
      }
    }
  }
  if (inSpeech && (env.length - segStart) >= minClipFrames) {
    rawSegments.push({
      startSec: Math.max(0, (segStart - padFrames) * 0.01),
      endSec: env.length * 0.01
    });
  }
  return rawSegments;
}

export function parsePlainTextLines() {
  const raw = document.getElementById('textareaLongSubs')?.value || '';
  const keepNumbers = document.getElementById('chkKeepLineNumbers')?.checked;
  return raw.split('\n').map(l => l.trim()).filter(Boolean).map((line, idx) => {
    const parts = line.split('||');
    let en = parts[0].trim();
    const zh = (parts[1] || '').trim();
    if (!keepNumbers) {
      en = en.replace(/^\d+[\.\)、\-\s]+/, '').trim();
    } else if (!/^\d+[\.\)、]/.test(en)) {
      en = `${idx + 1}. ${en}`;
    }
    return { en, zh };
  });
}

export function drawVadWaveformCanvas() {
  const canvas = document.getElementById('vadWaveformCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const env = state.vadEnvelopeDb;
  if (!env || !env.length) return;

  const totalSec = env.length * 0.01;
  // Draw detected speech segments in emerald green
  ctx.fillStyle = 'rgba(16, 185, 129, 0.22)';
  state.vadSegments.forEach(seg => {
    const x1 = (seg.startSec / totalSec) * w;
    const x2 = (seg.endSec / totalSec) * w;
    ctx.fillRect(x1, 0, Math.max(2, x2 - x1), h);
  });

  // Draw waveform bars
  ctx.fillStyle = '#38bdf8';
  const step = Math.max(1, Math.floor(env.length / w));
  for (let x = 0; x < w; x++) {
    const idx = Math.min(env.length - 1, x * step);
    const norm = Math.max(0, Math.min(1, (env[idx] + 60) / 55));
    const barH = norm * (h - 8);
    ctx.fillRect(x, h - barH, 1, barH);
  }

  // Draw threshold red dashed line
  const db = Number(document.getElementById('sliderVadDb')?.value || -30);
  const yNorm = Math.max(0, Math.min(1, (db + 60) / 55));
  const y = h - yNorm * (h - 8);
  ctx.strokeStyle = '#fb7185';
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(w, y);
  ctx.stroke();
  ctx.setLineDash([]);
}

export function refreshVadWorkbenchPreview() {
  const t0 = performance.now();
  const db = Number(document.getElementById('sliderVadDb')?.value || -30);
  const silenceMs = Number(document.getElementById('sliderVadSilenceMs')?.value || 320);
  const minClipMs = Number(document.getElementById('sliderVadMinClipMs')?.value || 400);
  const padMs = Number(document.getElementById('sliderVadPadMs')?.value || 120);

  document.getElementById('valVadDb').textContent = `${db} dB`;
  document.getElementById('valVadSilenceMs').textContent = `${silenceMs} ms`;
  document.getElementById('valVadMinClipMs').textContent = `${minClipMs} ms`;
  document.getElementById('valVadPadMs').textContent = `${padMs} ms`;

  if (state.vadEnvelopeDb) {
    state.vadSegments = computeVadSegmentsFromEnvelope(db, silenceMs, minClipMs, padMs);
  }
  const elapsed = (performance.now() - t0).toFixed(1);
  document.getElementById('vadCalcLatency').textContent = `${elapsed} ms`;
  renderVadChunkListUI();
  drawVadWaveformCanvas();
}

export function renderVadChunkListUI() {
  const subs = parsePlainTextLines();
  const segs = state.vadSegments || [];
  const statusText = document.getElementById('vadMatchStatusText');
  const badge = document.getElementById('vadMatchBadge');
  const headerTitle = document.getElementById('vadPreviewHeaderTitle');

  if (statusText) statusText.textContent = `音檔切出：${segs.length} 段 ｜ 字幕行數：${subs.length} 行`;
  if (headerTitle) headerTitle.textContent = `切分對齊預覽與微調清單 (音檔 ${segs.length} 段 ｜ 字幕 ${subs.length} 行)`;

  if (badge) {
    if (segs.length > 0 && segs.length === subs.length) {
      badge.textContent = '✅ 完美對齊';
      badge.className = 'px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-bold text-[11px]';
    } else if (segs.length === 0) {
      badge.textContent = '尚未切出段落';
      badge.className = 'px-2 py-0.5 rounded bg-slate-800 text-slate-400 font-bold text-[11px]';
    } else {
      const diff = segs.length - subs.length;
      badge.textContent = diff > 0 ? `⚠️ 音檔多 ${diff} 段` : `⚠️ 音檔少 ${Math.abs(diff)} 段`;
      badge.className = 'px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold text-[11px]';
    }
  }

  const listEl = document.getElementById('vadChunkPreviewList');
  if (!listEl) return;
  if (!segs.length) {
    listEl.innerHTML = `<div class="text-center py-6 text-slate-500">請調整上方 dB 門檻，或點擊「🧪 載入模擬 GPT 10句長音檔」體驗</div>`;
    return;
  }

  listEl.innerHTML = '';
  segs.forEach((seg, idx) => {
    const sub = subs[idx];
    const dur = (seg.endSec - seg.startSec).toFixed(1);
    const row = document.createElement('div');
    row.className = 'p-2.5 rounded-xl bg-slate-900 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2';
    row.innerHTML = `
      <div class="space-y-0.5 min-w-0 flex-1">
        <div class="flex items-center gap-2 font-mono text-[11px]">
          <span class="px-2 py-0.5 rounded bg-slate-800 text-sky-300 font-bold">#${formatIdx(idx + 1)}</span>
          <span class="text-slate-400">${seg.startSec.toFixed(1)}s - ${seg.endSec.toFixed(1)}s (${dur}s)</span>
        </div>
        <div class="text-xs font-bold ${sub ? 'text-white' : 'text-amber-300'} truncate">
          ${sub ? escapeHtml(sub.en) : '⚠️ 多出的音檔段落（無對應字幕，可合併或刪除）'}
        </div>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button type="button" data-act="play" data-idx="${idx}" class="px-2.5 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/50 text-sky-300 font-bold text-[11px]">▶ 試聽</button>
        <button type="button" data-act="split" data-idx="${idx}" class="px-2.5 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-400/40 text-amber-300 font-bold text-[11px]">✂️ 從中切開</button>
        ${idx < segs.length - 1 ? `<button type="button" data-act="merge" data-idx="${idx}" class="px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/40 text-emerald-300 font-bold text-[11px]">🔗 合併下段</button>` : ''}
        <button type="button" data-act="del" data-idx="${idx}" class="px-2 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-400/40 text-rose-300 font-bold text-[11px]">🗑️</button>
      </div>
    `;
    listEl.appendChild(row);
  });

  listEl.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.getAttribute('data-act');
      const i = Number(btn.getAttribute('data-idx'));
      handleVadChunkItemAction(act, i, btn);
    });
  });
}

export function handleVadChunkItemAction(act, idx, btnEl) {
  unlockiOSAudioAndSpeechSynchronously();
  const seg = state.vadSegments[idx];
  if (!seg) return;

  if (act === 'play') {
    if (!state.vadAudioBuffer) return;
    const sr = state.vadAudioBuffer.sampleRate;
    const raw = state.vadAudioBuffer.getChannelData(0);
    const s0 = Math.max(0, Math.floor(seg.startSec * sr));
    const s1 = Math.min(raw.length, Math.floor(seg.endSec * sr));
    const slice = raw.subarray(s0, s1);
    const wavUri = encodeMonoFloat32ToWavDataUri(slice, sr, 'rms', 1.0);
    const pAudio = document.getElementById('previewAudio');
    if (pAudio) {
      pAudio.src = wavUri;
      btnEl.textContent = '⏹ 播放中';
      pAudio.onended = () => { btnEl.textContent = '▶ 試聽'; };
      pAudio.play().catch(() => {});
    }
  } else if (act === 'split') {
    // Find quietest valley in the middle 60% of this segment
    const env = state.vadEnvelopeDb;
    const fStart = Math.floor(seg.startSec * 100);
    const fEnd = Math.floor(seg.endSec * 100);
    let splitSec = (seg.startSec + seg.endSec) / 2;
    if (env && fEnd - fStart > 20) {
      const m0 = fStart + Math.floor((fEnd - fStart) * 0.2);
      const m1 = fStart + Math.floor((fEnd - fStart) * 0.8);
      let minDb = 999;
      let minFrame = Math.floor((m0 + m1) / 2);
      for (let f = m0; f <= m1; f++) {
        if (env[f] < minDb) {
          minDb = env[f];
          minFrame = f;
        }
      }
      splitSec = minFrame * 0.01;
    }
    state.vadSegments.splice(
      idx,
      1,
      { startSec: seg.startSec, endSec: splitSec },
      { startSec: splitSec, endSec: seg.endSec }
    );
    renderVadChunkListUI();
    drawVadWaveformCanvas();
  } else if (act === 'merge' && idx < state.vadSegments.length - 1) {
    const nextSeg = state.vadSegments[idx + 1];
    state.vadSegments.splice(idx, 2, { startSec: seg.startSec, endSec: nextSeg.endSec });
    renderVadChunkListUI();
    drawVadWaveformCanvas();
  } else if (act === 'del') {
    state.vadSegments.splice(idx, 1);
    renderVadChunkListUI();
    drawVadWaveformCanvas();
  }
}

export function autoFindMatchingDbThreshold() {
  if (!state.vadEnvelopeDb) return;
  const targetLines = parsePlainTextLines().length;
  if (targetLines <= 0) {
    showGiantHud('⚠️', '請先貼上字幕文字', '需要知道目標行數才能自動對齊', 'border-amber-400/90');
    return;
  }
  const silenceMs = Number(document.getElementById('sliderVadSilenceMs')?.value || 320);
  const minClipMs = Number(document.getElementById('sliderVadMinClipMs')?.value || 400);
  const padMs = Number(document.getElementById('sliderVadPadMs')?.value || 120);

  let bestDb = -30;
  let bestDiff = 9999;
  for (let db = -52; db <= -14; db++) {
    const segs = computeVadSegmentsFromEnvelope(db, silenceMs, minClipMs, padMs);
    const diff = Math.abs(segs.length - targetLines);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestDb = db;
      if (diff === 0) break;
    }
  }
  const slider = document.getElementById('sliderVadDb');
  if (slider) slider.value = String(bestDb);
  refreshVadWorkbenchPreview();
}

export function generateSimulatedGpt10SentenceLongAudio() {
  const ctx = getAudioContext();
  const sr = 16000;
  const demo10 = DEFAULT_SENTENCES.slice(0, 10);
  const totalSec = 26;
  const buf = ctx.createBuffer(1, sr * totalSec, sr);
  const ch = buf.getChannelData(0);

  // Fill background noise floor (-35 dB)
  for (let i = 0; i < ch.length; i++) {
    ch[i] = (Math.random() * 2 - 1) * 0.015;
  }

  let cursorSec = 0.4;
  demo10.forEach((_, idx) => {
    const dur = 1.9;
    const s0 = Math.floor(cursorSec * sr);
    const s1 = Math.min(ch.length, Math.floor((cursorSec + dur) * sr));
    const freq = 220 + (idx % 5) * 45;
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / sr;
      ch[i] += Math.sin(2 * Math.PI * freq * t) * 0.25;
    }
    cursorSec += dur + 0.55;
  });

  document.getElementById('textareaLongSubs').value = demo10.map(d => `${d.en} || ${d.zh}`).join('\n');
  document.getElementById('vadAudioFileMeta').textContent = `模擬GPT長音檔 (26.0s / 16kHz)`;
  precomputeAudioEnvelope(buf);
  autoFindMatchingDbThreshold();
}

export function buildSplitPackFromVad(packName, normMode = 'rms') {
  if (!state.vadAudioBuffer || !state.vadSegments.length) return null;

  const subs = parsePlainTextLines();
  const sr = state.vadAudioBuffer.sampleRate;
  const raw = state.vadAudioBuffer.getChannelData(0);

  let globalGain = 1.0;
  if (normMode === 'global') {
    let maxPeak = 0.01;
    for (let i = 0; i < raw.length; i++) {
      const a = Math.abs(raw[i]);
      if (a > maxPeak) maxPeak = a;
    }
    globalGain = Math.min(4.0, 0.88 / maxPeak);
  }

  const items = state.vadSegments.map((seg, idx) => {
    const s0 = Math.max(0, Math.floor(seg.startSec * sr));
    const s1 = Math.min(raw.length, Math.floor(seg.endSec * sr));
    const slice = raw.subarray(s0, s1);
    const wavUri = encodeMonoFloat32ToWavDataUri(slice, sr, normMode, globalGain);
    const sub = subs[idx] || { en: `${idx + 1}. Sentence #${idx + 1}`, zh: '' };
    return {
      index: idx,
      en: sub.en,
      zh: sub.zh,
      aiNotes: '',
      aiGrammarNote: '',
      wordNotes: {},
      audioDataUri: wavUri,
      durationSec: Number((seg.endSec - seg.startSec).toFixed(1))
    };
  });

  const cleanName = (packName || '長音檔切分教材').trim();
  return {
    id: 'pack_' + Date.now(),
    name: `${cleanName} (${items.length}句)`,
    createdAt: Date.now(),
    audioModeLabel: '長音檔精準切分',
    isDemoTTS: false,
    items
  };
}

// ==========================================
// TAB B: ZIP LAZY-PACK & MULTI-FILE IMPORTER
// ==========================================
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|aac|ogg|webm)$/i;
const SUB_EXT_RE = /\.(txt|json|srt)$/i;

function naturalCompareNames(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, {
    numeric: true,
    sensitivity: 'base'
  });
}

function getBaseNameWithoutExt(filename) {
  const leaf = String(filename || '').split('/').pop() || '';
  return leaf.replace(/\.[^.]+$/, '').trim().toLowerCase();
}

function guessAudioMimeFromName(filename) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.m4a') || lower.endsWith('.aac')) return 'audio/mp4';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.webm')) return 'audio/webm';
  return 'audio/mpeg';
}

function arrayBufferToBase64DataUri(arrBuf, mime) {
  const bytes = new Uint8Array(arrBuf);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function downsampleMonoIfNeeded(samples, srcRate, maxRate = 16000) {
  if (srcRate <= maxRate) return { samples, sampleRate: srcRate };
  const ratio = srcRate / maxRate;
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = samples[idx] || 0;
    const s1 = samples[Math.min(samples.length - 1, idx + 1)] || s0;
    out[i] = s0 + (s1 - s0) * frac;
  }
  return { samples: out, sampleRate: maxRate };
}

function parseSubtitleContent(text, filename) {
  const lower = String(filename || '').toLowerCase();
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw) return [];

  if (lower.endsWith('.json')) {
    try {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : []);
      return arr.map((entry, idx) => {
        if (typeof entry === 'string') {
          const [enPart, zhPart] = entry.split('||');
          return { en: (enPart || '').trim(), zh: (zhPart || '').trim() };
        }
        return {
          en: String(entry?.en || entry?.text || `${idx + 1}. Sentence #${idx + 1}`).trim(),
          zh: String(entry?.zh || entry?.translation || '').trim()
        };
      }).filter(x => x.en);
    } catch (e) {
      return [];
    }
  }

  if (lower.endsWith('.srt')) {
    const blocks = raw.split(/\r?\n\r?\n+/);
    const list = [];
    for (const block of blocks) {
      const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const contentLines = lines.filter(l => !/^\d+$/.test(l) && !/-->/.test(l));
      if (!contentLines.length) continue;
      if (contentLines.length >= 2) {
        list.push({ en: contentLines[0], zh: contentLines.slice(1).join(' ') });
      } else {
        const [enPart, zhPart] = contentLines[0].split('||');
        list.push({ en: (enPart || '').trim(), zh: (zhPart || '').trim() });
      }
    }
    return list;
  }

  // Plain .txt (one line per sentence, optional "||" for Chinese translation)
  return raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const parts = line.split('||');
    return {
      en: (parts[0] || '').trim(),
      zh: (parts[1] || '').trim()
    };
  });
}

async function convertAudioBufferToNormalizedClip(arrBuf, filename) {
  const ctx = getAudioContext();
  if (ctx) {
    try {
      const decoded = await ctx.decodeAudioData(arrBuf.slice(0));
      const mono = decoded.getChannelData(0);
      const { samples, sampleRate } = downsampleMonoIfNeeded(mono, decoded.sampleRate, 16000);
      const wavUri = encodeMonoFloat32ToWavDataUri(samples, sampleRate, 'rms', 1.0);
      return {
        audioDataUri: wavUri,
        durationSec: Number(Math.max(0.4, decoded.duration).toFixed(1))
      };
    } catch (e) {}
  }
  const mime = guessAudioMimeFromName(filename);
  return {
    audioDataUri: arrayBufferToBase64DataUri(arrBuf, mime),
    durationSec: 3.0
  };
}

export async function generateAndDownloadDemoZip() {
  if (typeof window.JSZip === 'undefined') {
    showGiantHud('⚠️', 'JSZip 尚未載入', '請確認網路連線後重新整理頁面', 'border-rose-400/90');
    return;
  }
  const zip = new window.JSZip();
  const demo10 = DEFAULT_SENTENCES.slice(0, 10);
  const subtitleLines = [];

  demo10.forEach((item, idx) => {
    const num = formatIdx(idx + 1);
    const dur = Number((2.2 + (item.en.length % 10) * 0.12).toFixed(1));
    const wavDataUri = createToneWavDataUri(dur, 400 + idx * 28, 0.06);
    const b64 = wavDataUri.split(',')[1];
    zip.file(`${num}.wav`, b64, { base64: true });
    subtitleLines.push(`${item.en} || ${item.zh}`);
  });

  zip.file('sentences.txt', subtitleLines.join('\n'));
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Pack_01.zip';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  showGiantHud('⬇️', '已產生測試 Pack_01.zip', '內含 10 句 WAV 音檔與 sentences.txt', 'border-emerald-400/90');
}

export async function importZipOrMultiFiles(fileList, packNameInput, onStatusUpdate = () => {}) {
  const files = Array.from(fileList || []);
  if (!files.length) {
    throw new Error('請先選擇 ZIP 壓縮檔或多檔音訊');
  }

  const audioEntries = [];
  const subEntries = [];
  let inferredName = (packNameInput || '').trim();

  for (const file of files) {
    const name = file.name || '';
    if (name.toLowerCase().endsWith('.zip')) {
      if (typeof window.JSZip === 'undefined') {
        throw new Error('JSZip 元件未載入，無法解壓縮 ZIP');
      }
      if (!inferredName || inferredName === 'ZIP_匯入教材') {
        inferredName = name.replace(/\.zip$/i, '');
      }
      onStatusUpdate(`📦 正在解壓縮 ${name}...`);
      const zip = await window.JSZip.loadAsync(file);
      const entryNames = Object.keys(zip.files).sort(naturalCompareNames);

      for (const path of entryNames) {
        const entry = zip.files[path];
        if (entry.dir) continue;
        const leaf = path.split('/').pop() || '';
        if (!leaf || leaf.startsWith('.') || path.includes('__MACOSX/')) continue;

        if (AUDIO_EXT_RE.test(leaf)) {
          audioEntries.push({
            name: leaf,
            getArrayBuffer: () => entry.async('arraybuffer')
          });
        } else if (SUB_EXT_RE.test(leaf)) {
          subEntries.push({
            name: leaf,
            getText: () => entry.async('string')
          });
        }
      }
    } else if (AUDIO_EXT_RE.test(name)) {
      audioEntries.push({
        name,
        getArrayBuffer: () => file.arrayBuffer()
      });
    } else if (SUB_EXT_RE.test(name)) {
      subEntries.push({
        name,
        getText: () => file.text()
      });
    }
  }

  audioEntries.sort((a, b) => naturalCompareNames(a.name, b.name));
  subEntries.sort((a, b) => naturalCompareNames(a.name, b.name));

  if (!audioEntries.length) {
    throw new Error('未找到任何音訊檔 (.mp3 / .wav / .m4a / .aac / .ogg)');
  }

  // Parse per-clip subtitles (e.g. 01.txt) and/or combined subtitle list (e.g. sentences.txt)
  const audioBaseSet = new Set(audioEntries.map(a => getBaseNameWithoutExt(a.name)));
  const perClipSubMap = new Map();
  let combinedSubs = [];

  for (const subEntry of subEntries) {
    const text = await subEntry.getText();
    const base = getBaseNameWithoutExt(subEntry.name);
    const isPerClip = subEntries.length > 1 && audioBaseSet.has(base) && subEntry.name.toLowerCase().endsWith('.txt');
    if (isPerClip) {
      const parsedLines = parseSubtitleContent(text, subEntry.name);
      if (parsedLines.length > 0) {
        perClipSubMap.set(base, {
          en: parsedLines[0].en,
          zh: parsedLines[0].zh || (parsedLines[1]?.en || '')
        });
      }
    } else if (combinedSubs.length === 0) {
      combinedSubs = parseSubtitleContent(text, subEntry.name);
    }
  }

  const items = [];
  for (let i = 0; i < audioEntries.length; i++) {
    const entry = audioEntries[i];
    onStatusUpdate(`🎚️ 處理與平衡音訊 (${i + 1}/${audioEntries.length})：${entry.name}`);
    const arrBuf = await entry.getArrayBuffer();
    const clip = await convertAudioBufferToNormalizedClip(arrBuf, entry.name);
    const base = getBaseNameWithoutExt(entry.name);
    const sub = perClipSubMap.get(base) || combinedSubs[i] || {
      en: `${i + 1}. ${entry.name.replace(/\.[^.]+$/, '')}`,
      zh: ''
    };
    const enText = /^\d+[\.\)、]/.test(sub.en) ? sub.en : `${i + 1}. ${sub.en}`;
    items.push({
      index: i,
      en: enText,
      zh: sub.zh || '',
      aiNotes: '',
      aiGrammarNote: '',
      wordNotes: {},
      audioDataUri: clip.audioDataUri,
      durationSec: clip.durationSec
    });
  }

  const finalName = inferredName || 'ZIP_匯入教材';
  return {
    id: 'pack_' + Date.now(),
    name: `${finalName} (${items.length}句)`,
    createdAt: Date.now(),
    audioModeLabel: 'ZIP / 獨立音檔',
    isDemoTTS: false,
    items
  };
}

// ==========================================
// AUDIO CHUNKING & 16kHz WAV ENCODING FOR AI TRANSCRIPTION
// ==========================================
function mixDownAudioBufferToMono(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels || 1;
  const len = audioBuffer.length;
  if (numChannels === 1) return audioBuffer.getChannelData(0);
  const mono = new Float32Array(len);
  const inv = 1 / numChannels;
  for (let ch = 0; ch < numChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      mono[i] += data[i] * inv;
    }
  }
  return mono;
}

function encodeFloat32SliceToWavArrayBuffer(samples, sampleRate) {
  const len = samples.length;
  // Gentle gain boost only if recording is very quiet so ASR recognizes soft speech cleanly
  let maxPeak = 0;
  for (let i = 0; i < len; i++) {
    const a = Math.abs(samples[i]);
    if (a > maxPeak) maxPeak = a;
  }
  const gain = (maxPeak > 0.005 && maxPeak < 0.2) ? Math.min(4.0, 0.7 / maxPeak) : 1.0;

  const buffer = new ArrayBuffer(44 + len * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + len * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, len * 2, true);

  for (let i = 0; i < len; i++) {
    let s = samples[i] * gain;
    if (s > 0.98) s = 0.98;
    else if (s < -0.98) s = -0.98;
    view.setInt16(44 + i * 2, s * 32767, true);
  }
  return buffer;
}

function arrayBufferToPureBase64(arrBuf) {
  const bytes = new Uint8Array(arrBuf);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function buildTranscribeAudioChunks(audioBuffer, maxChunkSec = 300) {
  const monoFull = mixDownAudioBufferToMono(audioBuffer);
  const { samples, sampleRate } = downsampleMonoIfNeeded(monoFull, audioBuffer.sampleRate, 16000);
  const totalSec = samples.length / sampleRate;
  const env = state.vadEnvelopeDb;

  const boundaries = [0];
  let cursorSec = 0;
  while (totalSec - cursorSec > maxChunkSec + 10) {
    let splitSec = cursorSec + maxChunkSec;
    // Prefer splitting at the quietest valley within [splitSec - 15s, splitSec + 5s] to avoid cutting mid-word
    if (env && env.length > 0) {
      const fStart = Math.max(0, Math.floor((splitSec - 15) * 100));
      const fEnd = Math.min(env.length - 1, Math.floor((splitSec + 5) * 100));
      let minDb = 999;
      let bestFrame = Math.floor(splitSec * 100);
      for (let f = fStart; f <= fEnd; f++) {
        if (env[f] < minDb) {
          minDb = env[f];
          bestFrame = f;
        }
      }
      splitSec = bestFrame * 0.01;
    }
    boundaries.push(splitSec);
    cursorSec = splitSec;
  }
  boundaries.push(totalSec);

  const chunks = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const startSec = boundaries[i];
    const endSec = boundaries[i + 1];
    const s0 = Math.max(0, Math.floor(startSec * sampleRate));
    const s1 = Math.min(samples.length, Math.floor(endSec * sampleRate));
    if (s1 - s0 < sampleRate * 0.2) continue;
    const wavBuf = encodeFloat32SliceToWavArrayBuffer(samples.subarray(s0, s1), sampleRate);
    chunks.push({
      index: chunks.length,
      startSec,
      endSec,
      wavBlob: new Blob([wavBuf], { type: 'audio/wav' }),
      toBase64: () => arrayBufferToPureBase64(wavBuf)
    });
  }
  return chunks;
}

// EOF: js/audio-processor.js