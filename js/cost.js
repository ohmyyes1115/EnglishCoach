// Layer 1: Cost Estimates & Monthly Spend Ledger
// Everything here is an estimate worked out from published list prices; no provider returns an amount.
// Kept apart from the modules that make the calls so that all of them (translation, lookups,
// transcription, GPT-Live) can price and record what they used.

import { safeStorage } from './state-storage.js';

// ==========================================
// USAGE & COST ESTIMATE
// ==========================================
// The token counts come from the provider and are exact. The amount is an estimate: the API never returns a
// price, so it is worked out from this table. US dollars per 1M tokens (input, output), standard pay-as-you-go
// text rates as published on the OpenAI and Google pricing pages on 2026-11-25. A model that is not listed
// gets token counts only. Rows with several entries change price on the given date.
// free: Google offers a free tier for the model, inside which nothing is charged.
export const USD_TO_TWD_ESTIMATE = 32.5; // same rough rate as the call-cost display in gpt-live.js
const MODEL_PRICES = {
  'gpt-6.2-astra': [{ in: 8, out: 40 }],
  'gpt-6.2-sol': [{ in: 2, out: 10 }],
  'gpt-6.1-sol': [{ in: 2, out: 10 }],
  'gpt-6-astra': [{ in: 10, out: 50 }],
  'gpt-6-sol': [{ in: 2, out: 10 }],
  'gpt-5.5': [{ in: 5, out: 30 }],
  'gpt-5.4': [{ in: 2.5, out: 15 }],
  'gpt-5.4-mini': [{ in: 0.75, out: 4.5 }],
  'gpt-5.2': [{ in: 1.75, out: 14 }],
  'gpt-5.1': [{ in: 1.25, out: 10 }],
  'gpt-5': [{ in: 1.25, out: 10 }],
  'gpt-5-mini': [{ in: 0.25, out: 2 }],
  'gpt-4.1': [{ in: 2, out: 8 }],
  'gpt-4.1-mini': [{ in: 0.4, out: 1.6 }],
  'gpt-4o': [{ in: 2.5, out: 10 }],
  'gpt-4o-mini': [{ in: 0.15, out: 0.6 }],
  'gemini-4-carbon': [{ in: 2, out: 10 }, { from: '2026-12-01', in: 4, out: 20 }],
  'gemini-4-neon': [{ in: 3, out: 15 }],
  'gemini-4-argon': [{ in: 2, out: 10 }, { from: '2026-12-01', in: 4, out: 20 }],
  'gemini-4-hydrogen': [{ in: 1.5, out: 7.5, free: true }],
  'gemini-3.8-flash': [{ in: 0.75, out: 3.75, free: true }, { from: '2027-01-01', in: 1.5, out: 7.5, free: true }],
  'gemini-3.6-flash': [{ in: 0.75, out: 3.75, free: true }, { from: '2027-01-01', in: 1.5, out: 7.5, free: true }],
  'gemini-3.1-pro-preview': [{ in: 2, out: 12 }],
  'gemini-3-flash-preview': [{ in: 0.5, out: 3, free: true }]
};

function priceFor(model, now) {
  const rows = MODEL_PRICES[model];
  if (!rows) return null;
  const today = now.toISOString().slice(0, 10);
  let current = rows[0];
  rows.forEach((row) => { if (row.from && row.from <= today) current = row; });
  return current;
}

// Shown beside each model in the list; '' when the model has no price on file
export function describeModelPrice(model, now = new Date()) {
  const price = priceFor(model, now);
  if (!price) return '';
  return `每百萬 token：輸入 $${price.in}／輸出 $${price.out}${price.free ? '｜有免費額度' : ''}`;
}

export const hasReportedUsage = (usage) => Boolean(usage) && usage.requests > usage.unreportedRequests;

// Returns { usd, twd, free } or null when the model has no price on file or nothing was reported
export function estimateCost(model, usage, now = new Date()) {
  const price = priceFor(model, now);
  if (!price || !hasReportedUsage(usage)) return null;
  const usd = (usage.inputTokens * price.in + usage.outputTokens * price.out) / 1e6;
  return { usd, twd: usd * USD_TO_TWD_ESTIMATE, free: Boolean(price.free) };
}

export const formatUsd = (usd) => `US$${usd.toFixed(usd >= 1 ? 2 : usd >= 0.01 ? 3 : 4)}`;
export const formatTwd = (twd) => `NT$${twd.toFixed(twd >= 10 ? 0 : twd >= 0.1 ? 1 : 2)}`;

// One line for the result display; '' when the provider reported nothing at all
export function describeUsage(engine, usage, now = new Date()) {
  if (!hasReportedUsage(usage)) return '';
  const count = (n) => Math.round(n).toLocaleString('en-US');
  let text = `用量：輸入 ${count(usage.inputTokens)}、輸出 ${count(usage.outputTokens)} token（輸出含模型思考）`;
  const cost = estimateCost(engine.model, usage, now);
  text += cost
    ? `｜依公開定價估算約 ${formatUsd(cost.usd)}（約 ${formatTwd(cost.twd)}）${cost.free ? '；若用的是 Gemini 免費額度則不扣款' : ''}`
    : '｜沒有這個模型的單價資料，無法估算金額';
  if (usage.unreportedRequests > 0) text += `｜另有 ${usage.unreportedRequests} 次請求沒有回報用量，實際會再多一些`;
  return text;
}

// ==========================================
// AUDIO TRANSCRIPTION PRICES
// ==========================================
// US dollars per hour of audio. Groq: the speech-to-text page of its docs; OpenAI: "Whisper ... $0.006 / minute"
// on its pricing page. Both read on 2026-11-26. Groq bills at least 10 seconds for every request.
// Gemini transcription is not priced here: its audio input rate is not the text rate in the table above.
const AUDIO_PRICES_PER_HOUR = {
  groq: { 'whisper-large-v3': 0.111, 'whisper-large-v3-turbo': 0.04 },
  openai: { 'whisper-1': 0.36 }
};
const GROQ_MIN_BILLED_SEC = 10;

// One transcription request. Returns { usd, twd, free } or null when this model has no audio price on file.
// free: the provider has a free plan, on which nothing is charged.
export function estimateAudioCost(provider, model, seconds) {
  const perHour = AUDIO_PRICES_PER_HOUR[provider]?.[model];
  if (!Number.isFinite(perHour) || !(seconds >= 0)) return null;
  const billedSec = provider === 'groq' ? Math.max(GROQ_MIN_BILLED_SEC, seconds) : seconds;
  const usd = (billedSec / 3600) * perHour;
  return { usd, twd: usd * USD_TO_TWD_ESTIMATE, free: provider === 'groq' };
}

// One line for the transcription result. spend: { audioSec, usd, pricedRequests, unpricedRequests, free }
export function describeAudioUsage(spend) {
  const sec = Math.round(spend.audioSec);
  const length = sec >= 60 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${sec} 秒`;
  let text = `聽打用量：音訊 ${length}`;
  if (spend.pricedRequests > 0) {
    text += `｜依公開定價估算約 ${formatUsd(spend.usd)}（約 ${formatTwd(spend.usd * USD_TO_TWD_ESTIMATE)}）${spend.free ? '；若你的 Groq 是免費方案則不扣款' : ''}`;
    if (spend.unpricedRequests > 0) text += `｜另有 ${spend.unpricedRequests} 段沒有單價資料，未計入`;
  } else {
    text += '｜沒有這個聽打模型的單價資料，無法估算金額';
  }
  return text;
}

// "約 NT$0.12" for a single small request (shown beside the model name); '' without a price
export function describeSmallCost(cost) {
  return cost ? `約 ${formatTwd(cost.twd)}` : '';
}

// ==========================================
// MONTHLY SPEND LEDGER
// ==========================================
// { months: { "2026-11": { translate: { usd, maybeFreeUsd, count, unpriced }, lookup: {...}, ... } } }
// usd: estimated amount at list price. maybeFreeUsd: the part of it spent on a service that has a free
// tier or free plan (so it may not have been charged at all). count: recorded uses. unpriced: uses whose
// amount could not be estimated (no price on file, or the provider reported no usage).
const SPEND_LEDGER_LS_KEY = 'car_shadowing_spend_ledger_v1';
const SPEND_MONTHS_KEPT = 12;
export const SPEND_KIND_LABELS = {
  translate: '翻譯',
  lookup: 'AI 簡答與查單字',
  transcribe: '聽打',
  gptLive: 'GPT-Live 通話'
};

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function loadSpendLedger() {
  try {
    const parsed = JSON.parse(safeStorage.getItem(SPEND_LEDGER_LS_KEY) || 'null');
    if (parsed && typeof parsed.months === 'object' && parsed.months) return parsed;
  } catch (e) {}
  return { months: {} };
}

// cost: { usd, free } from one of the estimate functions, or null when the amount is unknown
export function recordSpend(kind, cost, now = new Date()) {
  if (!SPEND_KIND_LABELS[kind]) return;
  try {
    const ledger = loadSpendLedger();
    const key = monthKey(now);
    const month = ledger.months[key] || (ledger.months[key] = {});
    const row = month[kind] || (month[kind] = { usd: 0, maybeFreeUsd: 0, count: 0, unpriced: 0 });
    row.count += 1;
    if (cost && Number.isFinite(cost.usd)) {
      row.usd = Number((row.usd + cost.usd).toFixed(6));
      if (cost.free) row.maybeFreeUsd = Number(((row.maybeFreeUsd || 0) + cost.usd).toFixed(6));
    } else {
      row.unpriced += 1;
    }
    Object.keys(ledger.months).sort().slice(0, -SPEND_MONTHS_KEPT).forEach((old) => { delete ledger.months[old]; });
    safeStorage.setItem(SPEND_LEDGER_LS_KEY, JSON.stringify(ledger));
  } catch (e) {}
}

// { key, kinds: [{ kind, label, usd, maybeFreeUsd, count, unpriced }], usd, maybeFreeUsd, count, unpriced }
export function readMonthSpend(now = new Date()) {
  const key = monthKey(now);
  const month = loadSpendLedger().months[key] || {};
  const kinds = Object.keys(SPEND_KIND_LABELS)
    .filter((kind) => month[kind] && month[kind].count > 0)
    .map((kind) => ({
      kind,
      label: SPEND_KIND_LABELS[kind],
      usd: Number(month[kind].usd) || 0,
      maybeFreeUsd: Number(month[kind].maybeFreeUsd) || 0,
      count: Number(month[kind].count) || 0,
      unpriced: Number(month[kind].unpriced) || 0
    }));
  const sum = (field) => kinds.reduce((total, row) => total + row[field], 0);
  return { key, kinds, usd: sum('usd'), maybeFreeUsd: sum('maybeFreeUsd'), count: sum('count'), unpriced: sum('unpriced') };
}

const formatAmount = (usd) => `${formatUsd(usd)}（約 ${formatTwd(usd * USD_TO_TWD_ESTIMATE)}）`;

// Short form for a result line; '' when nothing was recorded this month
export function describeMonthSpendLine(now = new Date()) {
  const month = readMonthSpend(now);
  if (month.count === 0) return '';
  return `本月 AI 花費估算累計約 ${formatAmount(month.usd)}`;
}

// Lines for the AI settings window: this month in detail, last month as one line
export function describeMonthSpendDetail(now = new Date()) {
  const month = readMonthSpend(now);
  const title = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月`;
  const lines = [];
  if (month.count === 0) {
    lines.push(`${title}：還沒有記錄`);
  } else {
    lines.push(`${title}合計：約 ${formatAmount(month.usd)}`);
    month.kinds.forEach((row) => {
      const amount = row.count > row.unpriced ? `約 ${formatAmount(row.usd)}` : '沒有單價資料';
      lines.push(`・${row.label}：${amount}｜${row.count} 次${row.unpriced > 0 && row.count > row.unpriced ? `，其中 ${row.unpriced} 次沒有單價資料` : ''}`);
    });
    if (month.maybeFreeUsd > 0) {
      lines.push(`其中約 ${formatUsd(month.maybeFreeUsd)} 用的是有免費額度的服務（Gemini 免費額度、Groq 免費方案），實際可能沒有扣款`);
    }
  }
  const last = readMonthSpend(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  if (last.count > 0) lines.push(`上個月合計：約 ${formatAmount(last.usd)}`);
  return lines;
}
