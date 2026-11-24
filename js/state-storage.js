// Layer 0: Constants, Shared Global State, SafeStorage, IndexedDB & Common Utilities

export const APP_VERSION = 'v2.2.1';
export const DB_NAME = 'CarShadowingPlayerDB_v2';
export const DB_VERSION = 2;
export const STORE_PACKS = 'course_packs';
export const PREFS_LS_KEY = 'car_shadow_prefs_v2';
export const AI_CONFIG_LS_KEY = 'car_shadow_ai_config_v2';
export const KEYMAP_LS_KEY = 'car_shadow_keymap_v2';

export const SPEED_STEPS = [1.0, 0.85, 0.75, 1.15];

export const DEFAULT_SENTENCES = [
  { en: "1. Could you walk me through the timeline for this project?", zh: "你能帶我順一遍這個專案的時程表嗎？" },
  { en: "2. Let's touch base again early next week to review the progress.", zh: "我們下週一早再聯繫一下，檢視目前的進度。" },
  { en: "3. We need to identify the root cause before deploying the hotfix.", zh: "在部署緊急修正檔之前，我們需要先找出根本原因。" },
  { en: "4. I'll loop you in on the email thread right after this meeting.", zh: "這場會議結束後，我馬上把你加進那串郵件討論。" },
  { en: "5. The latency spike seems to be triggered by a database lock.", zh: "延遲暴增似乎是由資料庫鎖定所觸發的。" },
  { en: "6. Let's keep the scope manageable so we can hit the deadline.", zh: "我們把範圍控制在可管理的程度，才能如期趕上截止日。" },
  { en: "7. Feel free to chime in if you spot any edge cases.", zh: "如果你發現任何極端邊界狀況，請隨時提出來。" },
  { en: "8. We are currently waiting for sign-off from the security team.", zh: "我們目前正在等待資安團隊的簽核批准。" },
  { en: "9. Can we push this agenda item to our next sprint planning?", zh: "我們可以把這個議程項目順延到下一次的衝刺規劃會議嗎？" },
  { en: "10. Everything looks solid on my end, so we're good to go.", zh: "我這邊看起來一切正常，我們可以正式上線了。" },
  { en: "11. Let's make sure our API changes are backward compatible.", zh: "我們要確保這次的 API 修改具備向下相容性。" },
  { en: "12. I'm bandwidth-constrained today, could we sync up tomorrow?", zh: "我今天手頭上的工作滿載，我們能明天再同步嗎？" },
  { en: "13. We should benchmark the memory footprint under heavy load.", zh: "我們應該測量一下高負載狀態下的記憶體佔用量。" },
  { en: "14. Please keep me posted if anything changes on the client side.", zh: "如果客戶端那邊有任何變動，請隨時讓我知道。" },
  { en: "15. Let's break this epic down into smaller actionable tasks.", zh: "我們把這個大型需求拆解成更小、可執行的工作項目吧。" },
  { en: "16. That's a valid point, let's factor that into our design.", zh: "這個觀點很有道理，我們把它納入架構設計考量。" },
  { en: "17. Can you double-check if the staging server is up and running?", zh: "你能再確認一下測試伺服器是否已經正常啟動運作嗎？" },
  { en: "18. We rolled back the release to prevent further service disruption.", zh: "我們退回了這次的版本發布，以避免服務進一步中斷。" },
  { en: "19. Let's align on the key deliverables before wrapping up.", zh: "在結束會議前，我們先對齊幾個核心的交付成果。" },
  { en: "20. Thanks for pulling this together on such short notice.", zh: "感謝你在這麼短的時間內把這些資料整理出來。" }
];

export const DEFAULT_KEYMAP = {
  prev:    { label: '上一句',       codes: ['ArrowLeft', 'PageUp', 'MediaTrackPrevious'] },
  restart: { label: '回到這句開頭', codes: ['ArrowUp', 'KeyR', 'Backspace'] },
  play:    { label: '播放 / 暫停 (長按調速)', codes: ['Space', 'Enter', 'MediaPlayPause'] },
  next:    { label: '下一句',       codes: ['ArrowRight', 'PageDown', 'MediaTrackNext'] },
  speed:   { label: '切換語速',     codes: ['ArrowDown', 'KeyS'] },
  loop:    { label: '無限單句循環 (再按恢復原次數)', codes: ['KeyL'] },
  merge:   { label: '動態合併下一句', codes: ['KeyM'] },
  copy:    { label: '複製本句英文並暫停', codes: ['KeyC'] },
  ai:      { label: 'AI 簡答翻譯與解析', codes: ['KeyE', 'KeyA'] }
};

// A binding is a key code, optionally followed by "@2" / "@3" for a double / triple click of that key.
// Cheap remotes send key-down and key-up together the moment a button is pressed, so a long press is
// invisible to the page; counting quick repeated presses is the only way to get more actions per button.
export const MAX_KEY_CLICKS = 3;

export function makeKeyBinding(code, clicks) {
  return clicks > 1 ? `${code}@${clicks}` : code;
}

export function parseKeyBinding(binding) {
  const text = String(binding || '');
  const m = /^(.+)@([23])$/.exec(text);
  return m ? { code: m[1], clicks: Number(m[2]) } : { code: text, clicks: 1 };
}

export function cloneDefaultKeymap() {
  return JSON.parse(JSON.stringify(DEFAULT_KEYMAP));
}

export const state = {
  packs: [],
  currentPack: null,
  currentIndex: 0,
  repeatCountCurrent: 1,
  repeatTarget: 2,
  previousFiniteRepeatTarget: 2,
  gapMode: '1',
  speedIndex: 0,
  subMode: 'both', // 'both' | 'en' | 'hide'
  mergeSubMode: 'audio_only_shift', // 'audio_only_shift' | 'both_audio_and_text'
  undoMergeSnapshot: null,
  demoVoiceMode: 'tts_and_pad', // 'tts_and_pad' | 'tts_only'
  isPlaying: false,
  isInGap: false,
  pausedOffsetSec: 0,
  packProgressMap: {},
  keymap: cloneDefaultKeymap(),
  listeningKeyAction: null,
  aiConfig: { provider: 'gemini', geminiKey: '', groqKey: '', openaiKey: '' },
  activeLookupWord: '',
  // VAD Workbench state
  vadAudioBuffer: null,
  vadEnvelopeDb: null,
  vadSampleRate: 16000,
  vadHopSamples: 160,
  vadSegments: [],
  memoryPacksFallback: new Map()
};

// ==========================================
// SAFE STORAGE (localStorage + Memory Fallback)
// ==========================================
const memoryStorageFallback = new Map();

export const safeStorage = {
  getItem(key) {
    try {
      const val = window.localStorage.getItem(key);
      if (val !== null) return val;
    } catch (e) {}
    return memoryStorageFallback.has(key) ? memoryStorageFallback.get(key) : null;
  },
  setItem(key, value) {
    const strVal = String(value);
    memoryStorageFallback.set(key, strVal);
    try {
      window.localStorage.setItem(key, strVal);
    } catch (e) {}
  },
  removeItem(key) {
    memoryStorageFallback.delete(key);
    try {
      window.localStorage.removeItem(key);
    } catch (e) {}
  }
};

// ==========================================
// COMMON DOM & FORMATTING UTILITIES
// ==========================================
let hudTimeoutId = null;

export function safeOn(id, event, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
}

export function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatIdx(n) {
  return String(n).padStart(2, '0');
}

export function formatTimeSec(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const mins = Math.floor(s / 60);
  const rem = (s % 60).toFixed(1).padStart(4, '0');
  return `${String(mins).padStart(2, '0')}:${rem}`;
}

export function showGiantHud(icon, title, sub, borderClass = 'border-sky-400/90', durationMs = 1150) {
  const hud = document.getElementById('giantHud');
  const box = document.getElementById('giantHudBox');
  if (!hud || !box) return;
  document.getElementById('giantHudIcon').textContent = icon;
  document.getElementById('giantHudTitle').textContent = title;
  document.getElementById('giantHudSub').textContent = sub || '';
  box.className = `bg-slate-900/95 border-2 ${borderClass} rounded-3xl px-7 py-5 shadow-2xl text-center max-w-xs sm:max-w-md mx-4 transform scale-100 transition-transform duration-150`;
  hud.classList.remove('opacity-0');
  hud.classList.add('opacity-100');
  if (hudTimeoutId) clearTimeout(hudTimeoutId);
  hudTimeoutId = setTimeout(() => {
    hud.classList.remove('opacity-100');
    hud.classList.add('opacity-0');
  }, durationMs);
}

// ==========================================
// INPUT EVENT TRACE (WHAT A REMOTE / KEYBOARD ACTUALLY SENDS)
// ==========================================
// Kept apart from window.__diagLogs so a burst of key presses cannot push real errors out of that list.
export const keyEventLogs = [];
let keyEventLogListener = null;

export function setKeyEventLogListener(fn) {
  keyEventLogListener = fn;
}

export function logKeyEvent(msg) {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  keyEventLogs.unshift(`[${stamp}] ${msg}`);
  if (keyEventLogs.length > 80) keyEventLogs.pop();
  if (keyEventLogListener) {
    try { keyEventLogListener(); } catch (e) {}
  }
}

export function copyTextSynchronously(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch (e) {}
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  } catch (e) {}
}

// ==========================================
// INDEXEDDB PERSISTENCE
// ==========================================
export function openDatabase() {
  return new Promise((resolve) => {
    try {
      if (!window.indexedDB) return resolve(null);
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_PACKS)) {
          db.createObjectStore(STORE_PACKS, { keyPath: 'id' });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (err) {
      resolve(null);
    }
  });
}

export function sanitizePackForIndexedDB(pack) {
  return {
    id: pack.id,
    name: pack.name,
    createdAt: pack.createdAt || Date.now(),
    audioModeLabel: pack.audioModeLabel || 'WAV 獨立音檔',
    isDemoTTS: Boolean(pack.isDemoTTS),
    items: (pack.items || []).map((it, idx) => ({
      index: idx,
      en: it.en || '',
      zh: it.zh || '',
      aiNotes: it.aiNotes || '',
      aiGrammarNote: it.aiGrammarNote || '',
      wordNotes: (it.wordNotes && typeof it.wordNotes === 'object') ? it.wordNotes : {},
      audioDataUri: it.audioDataUri || null,
      durationSec: Number(it.durationSec) || 2.8
    }))
  };
}

let lastPackSaveErrorName = '';

// Resolves true only when the pack is durably written. Resolves false (never hangs) when IndexedDB is
// unavailable or the transaction fails/aborts, e.g. QuotaExceededError, which fires 'abort' without 'error'.
export async function savePackToDB(pack) {
  const clean = sanitizePackForIndexedDB(pack);
  state.memoryPacksFallback.set(clean.id, clean);

  const fail = (errName) => {
    lastPackSaveErrorName = errName || 'UnknownError';
    if (typeof window.logDiag === 'function') {
      window.logDiag('WARN', `教材寫入 IndexedDB 失敗 (${lastPackSaveErrorName})：${clean.name}`);
    }
    return false;
  };

  const db = await openDatabase();
  if (!db) return fail('IndexedDBUnavailable');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok, errName) => {
      if (settled) return;
      settled = true;
      resolve(ok ? true : fail(errName));
    };
    try {
      const tx = db.transaction([STORE_PACKS], 'readwrite');
      tx.objectStore(STORE_PACKS).put(clean);
      tx.oncomplete = () => finish(true);
      tx.onerror = (e) => finish(false, e?.target?.error?.name || tx.error?.name);
      tx.onabort = (e) => finish(false, tx.error?.name || e?.target?.error?.name);
    } catch (e) {
      finish(false, e?.name);
    }
  });
}

// For user-initiated saves (import, merge, normalize): tell the user the pack only lives in memory
export function showPackSaveFailedHud() {
  const reason = lastPackSaveErrorName === 'QuotaExceededError'
    ? '裝置儲存空間不足'
    : '瀏覽器無法寫入儲存區';
  showGiantHud(
    '⚠️',
    '教材未能寫入裝置',
    `${reason}；目前內容只在本次開啟有效，重新整理後會遺失`,
    'border-rose-400/90',
    4500
  );
}

export async function loadAllPacksFromDB() {
  const db = await openDatabase();
  if (!db) return Array.from(state.memoryPacksFallback.values());
  return new Promise((resolve) => {
    try {
      const tx = db.transaction([STORE_PACKS], 'readonly');
      const req = tx.objectStore(STORE_PACKS).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch (e) {
      resolve([]);
    }
  });
}

export async function deletePackFromDB(packId) {
  state.memoryPacksFallback.delete(packId);
  const db = await openDatabase();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction([STORE_PACKS], 'readwrite');
      tx.objectStore(STORE_PACKS).delete(packId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch (e) {
      resolve(false);
    }
  });
}

// ==========================================
// STORAGE PROTECTION (PERSISTENT STORAGE)
// ==========================================
// By default a browser may wipe a site's IndexedDB when the device runs low on space.
// Persistent storage asks it to keep the course packs until the user removes them.
// 'granted' | 'denied' | 'unsupported' | 'unknown' (not asked yet)
export const storageProtection = { status: 'unknown', usageBytes: null, quotaBytes: null };

export async function requestPersistentStorage() {
  try {
    const sm = navigator.storage;
    if (!sm || typeof sm.persist !== 'function') {
      storageProtection.status = 'unsupported';
    } else if (typeof sm.persisted === 'function' && await sm.persisted()) {
      storageProtection.status = 'granted';
    } else {
      storageProtection.status = (await sm.persist()) ? 'granted' : 'denied';
    }
  } catch (e) {
    storageProtection.status = 'unsupported';
  }
  await refreshStorageUsage();
  return storageProtection.status;
}

export async function refreshStorageUsage() {
  try {
    if (typeof navigator.storage?.estimate !== 'function') return;
    const est = await navigator.storage.estimate();
    storageProtection.usageBytes = Number.isFinite(est?.usage) ? est.usage : null;
    storageProtection.quotaBytes = Number.isFinite(est?.quota) ? est.quota : null;
  } catch (e) {}
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function describeStorageProtection() {
  const { status, usageBytes, quotaBytes } = storageProtection;
  const usage = usageBytes === null
    ? ''
    : `，已用 ${formatBytes(usageBytes)}${quotaBytes ? ` / 可用上限約 ${formatBytes(quotaBytes)}` : ''}`;
  if (status === 'granted') return `✅ 教材已受保護：瀏覽器不會自動清除${usage}`;
  if (status === 'denied') return `⚠️ 教材未受保護：裝置空間不足時瀏覽器可能自動清除，建議把 App 加到主畫面並定期匯出備份${usage}`;
  if (status === 'unsupported') return `⚠️ 這個瀏覽器不支援儲存保護，建議定期匯出備份${usage}`;
  return `儲存保護狀態確認中…${usage}`;
}

// ==========================================
// PREFS, AI CONFIG & KEYMAP PERSISTENCE
// ==========================================
export function savePrefsSync() {
  try {
    if (state.currentPack) {
      state.packProgressMap[state.currentPack.id] = state.currentIndex;
    }
    const payload = {
      lastPackId: state.currentPack ? state.currentPack.id : 'default_pack',
      packProgressMap: state.packProgressMap,
      repeatTarget: state.repeatTarget,
      previousFiniteRepeatTarget: state.previousFiniteRepeatTarget,
      gapMode: state.gapMode,
      speedIndex: state.speedIndex,
      subMode: state.subMode,
      mergeSubMode: state.mergeSubMode,
      demoVoiceMode: state.demoVoiceMode
    };
    safeStorage.setItem(PREFS_LS_KEY, JSON.stringify(payload));
  } catch (e) {}
}

export function loadPrefsSync() {
  try {
    const raw = safeStorage.getItem(PREFS_LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

export function loadAiConfigSync() {
  try {
    const raw = safeStorage.getItem(AI_CONFIG_LS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        provider: p.provider || 'gemini',
        geminiKey: (p.geminiKey || '').trim(),
        groqKey: (p.groqKey || '').trim(),
        openaiKey: (p.openaiKey || '').trim()
      };
    }
  } catch (e) {}
  return { provider: 'gemini', geminiKey: '', groqKey: '', openaiKey: '' };
}

export function saveAiConfigSync(cfg) {
  state.aiConfig = {
    provider: cfg.provider || 'gemini',
    geminiKey: (cfg.geminiKey || '').trim(),
    groqKey: (cfg.groqKey || '').trim(),
    openaiKey: (cfg.openaiKey || '').trim()
  };
  try {
    safeStorage.setItem(AI_CONFIG_LS_KEY, JSON.stringify(state.aiConfig));
  } catch (e) {}
}

export function loadKeymapSync() {
  const base = cloneDefaultKeymap();
  try {
    const raw = safeStorage.getItem(KEYMAP_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Only the bound keys are user data; labels and the set of actions always come from the current defaults.
      // One key may drive one action only (the first match wins at runtime), so drop duplicates while loading.
      const taken = new Set();
      const actions = Object.keys(base);
      const hasSaved = (action) => Array.isArray(parsed?.[action]?.codes);
      actions.filter(hasSaved).forEach((action) => {
        base[action].codes = parsed[action].codes.filter((c) => {
          if (typeof c !== 'string' || !c || taken.has(c)) return false;
          taken.add(c);
          return true;
        });
      });
      // Actions added in a later version keep their default keys, minus any the user already assigned elsewhere
      actions.filter((action) => !hasSaved(action)).forEach((action) => {
        base[action].codes = base[action].codes.filter((c) => !taken.has(c));
      });
    }
  } catch (e) {
    return cloneDefaultKeymap();
  }
  return base;
}

export function saveKeymapSync(keymapObj) {
  state.keymap = keymapObj;
  try {
    safeStorage.setItem(KEYMAP_LS_KEY, JSON.stringify(state.keymap));
  } catch (e) {}
}