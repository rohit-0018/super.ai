import { createCanvas } from '@napi-rs/canvas';
import { fmtPriceUsd } from '../common/format-price';

export interface OhlcvCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const SUBSCRIPTS = ['₀','₁','₂','₃','₄','₅','₆','₇','₈','₉'];
function toSub(n: number) {
  return String(n).split('').map(d => SUBSCRIPTS[+d] ?? d).join('');
}
function axisPrice(p: number): string {
  if (!p) return '$0';
  if (p >= 1)      return `$${p.toFixed(2)}`;
  if (p >= 0.01)   return `$${p.toFixed(4)}`;
  if (p >= 0.0001) return `$${p.toFixed(6)}`;
  const after = p.toFixed(20).slice(2);
  const m = after.match(/^(0+)(\d{1,4})/);
  if (!m) return `$${p.toExponential(2)}`;
  const extra = Math.max(0, m[1].length - 1);
  return `$0.0${toSub(extra)}${m[2]}`;
}

export function gtNetwork(chainId: string): string {
  const map: Record<string, string> = {
    solana: 'solana',
    ethereum: 'eth',
    bsc: 'bsc',
    base: 'base',
    arbitrum: 'arbitrum',
    polygon: 'polygon_pos',
    avalanche: 'avax',
    fantom: 'ftm',
    cronos: 'cro',
    optimism: 'optimism',
  };
  return map[chainId?.toLowerCase()] ?? chainId?.toLowerCase() ?? 'eth';
}

function parseTf(tf: string): { timeframe: string; aggregate: number } {
  if (tf === '5m')  return { timeframe: 'minute', aggregate: 5 };
  if (tf === '15m') return { timeframe: 'minute', aggregate: 15 };
  if (tf === '30m') return { timeframe: 'minute', aggregate: 30 };
  if (tf === '1h')  return { timeframe: 'hour', aggregate: 1 };
  if (tf === '4h')  return { timeframe: 'hour', aggregate: 4 };
  if (tf === '1d')  return { timeframe: 'day', aggregate: 1 };
  return { timeframe: 'minute', aggregate: 15 };
}

const OHLCV_TTL = 45_000;
const TF_PROBE_TTL = 120_000;

interface CacheEntry<T> { value: T; expiresAt: number; }
const ohlcvCache = new Map<string, CacheEntry<OhlcvCandle[]>>();
const probeCache = new Map<string, CacheEntry<boolean>>();

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const e = map.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expiresAt) { map.delete(key); return undefined; }
  return e.value;
}
function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, value: T, ttl: number) {
  map.set(key, { value, expiresAt: Date.now() + ttl });
}

export async function fetchOhlcv(
  network: string,
  poolAddress: string,
  tf: string,
): Promise<OhlcvCandle[]> {
  const cacheKey = `${network}:${poolAddress}:${tf}`;
  const cached = cacheGet(ohlcvCache, cacheKey);
  if (cached) return cached;

  const { timeframe, aggregate } = parseTf(tf);
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=40&currency=usd`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'qwai/1.0' },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 429) {
      if (attempt === 2) throw new Error('GeckoTerminal rate limited — try again in a moment');
      const delay = Math.min(parseInt(res.headers.get('Retry-After') ?? '2', 10) * 1000, 4_000);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    if (!res.ok) throw new Error(`GeckoTerminal OHLCV ${res.status}`);
    const body = await res.json() as any;
    const list: number[][] = body?.data?.attributes?.ohlcv_list ?? [];
    const candles = list
      .map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
      .reverse();
    cacheSet(ohlcvCache, cacheKey, candles, OHLCV_TTL);
    return candles;
  }
  throw new Error('GeckoTerminal OHLCV failed after retries');
}

type TfCategory = 'minute' | 'hour' | 'day';

function getTfCategory(tf: string): TfCategory {
  if (tf === '5m' || tf === '15m' || tf === '30m') return 'minute';
  if (tf === '1h' || tf === '4h')                  return 'hour';
  return 'day';
}

const CATEGORY_PROBE: Record<TfCategory, string> = { minute: '5m', hour: '1h', day: '1d' };
const CATEGORY_TFS:   Record<TfCategory, string[]> = {
  minute: ['5m', '15m'],
  hour:   ['1h', '4h'],
  day:    ['1d'],
};

async function probeCategory(network: string, poolAddress: string, cat: TfCategory): Promise<boolean> {
  const cacheKey = `probe:${network}:${poolAddress}:${cat}`;
  const cached = cacheGet(probeCache, cacheKey);
  if (cached !== undefined) return cached;

  try {
    const { timeframe, aggregate } = parseTf(CATEGORY_PROBE[cat]);
    const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=2&currency=usd`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'qwai/1.0' },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 429) { if (attempt === 1) return false; await new Promise(r => setTimeout(r, 1_500)); continue; }
      if (!res.ok) { cacheSet(probeCache, cacheKey, false, TF_PROBE_TTL); return false; }
      const body = await res.json() as any;
      const result = (body?.data?.attributes?.ohlcv_list?.length ?? 0) >= 2;
      cacheSet(probeCache, cacheKey, result, TF_PROBE_TTL);
      return result;
    }
    return false;
  } catch { return false; }
}

/** Returns the subset of ['5m','15m','1h','4h','1d'] that have >= 2 candles available. */
export async function getAvailableTfs(
  network: string,
  poolAddress: string,
  activeTf: string,
  activeOhlcvLen: number,
): Promise<string[]> {
  const activeCat = getTfCategory(activeTf);
  const otherCats = (['minute', 'hour', 'day'] as TfCategory[]).filter(c => c !== activeCat);

  const probeResults = await Promise.allSettled(otherCats.map(c => probeCategory(network, poolAddress, c)));

  const catOk: Record<TfCategory, boolean> = { minute: false, hour: false, day: false };
  catOk[activeCat] = activeOhlcvLen >= 2;
  otherCats.forEach((cat, i) => {
    catOk[cat] = probeResults[i].status === 'fulfilled' && probeResults[i].value === true;
  });

  return (Object.keys(CATEGORY_TFS) as TfCategory[]).flatMap(cat => catOk[cat] ? CATEGORY_TFS[cat] : []);
}

export async function generateCandleChart(
  candles: OhlcvCandle[],
  symbol: string,
  tf: string,
): Promise<Buffer> {
  const W = 800, H = 460;
  const PAD = { top: 38, right: 72, bottom: 46, left: 8 };
  const VOL_FRAC = 0.22;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  // Chart zone
  const cL = PAD.left, cR = W - PAD.right;
  const cT = PAD.top, cB = H - PAD.bottom;
  const cW = cR - cL, cH = cB - cT;

  const priceH = Math.floor(cH * (1 - VOL_FRAC)) - 4;
  const volT = cT + priceH + 8;
  const volH = cH - priceH - 8;

  const n = candles.length;

  if (n < 2) {
    ctx.fillStyle = '#485069';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No candle data available', W / 2, H / 2);
    return canvas.toBuffer('image/png');
  }

  // Price range
  const maxP = Math.max(...candles.map(c => c.high));
  const minP = Math.min(...candles.map(c => c.low));
  const pRange = (maxP - minP) || maxP * 0.01 || 0.01;
  const pad = pRange * 0.07;

  const maxVol = Math.max(...candles.map(c => c.volume)) || 1;

  const toX = (i: number) => cL + (i + 0.5) * (cW / n);
  const toY = (p: number) => cT + priceH - ((p - minP + pad) / (pRange + pad * 2)) * priceH;
  const toVolY = (v: number) => volT + volH - (v / maxVol) * volH * 0.92;

  const bodyW = Math.max(2, (cW / n) * 0.65);

  // Subtle grid
  ctx.strokeStyle = '#161b22';
  ctx.lineWidth = 1;
  const GRIDS = 5;
  for (let i = 0; i <= GRIDS; i++) {
    const y = cT + (priceH / GRIDS) * i;
    ctx.beginPath(); ctx.moveTo(cL, y); ctx.lineTo(cR, y); ctx.stroke();
  }
  for (let i = 0; i <= 4; i++) {
    const x = cL + (cW / 4) * i;
    ctx.beginPath(); ctx.moveTo(x, cT); ctx.lineTo(x, cT + priceH); ctx.stroke();
  }

  // Candles
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const bull = c.close >= c.open;
    const color = bull ? '#26a69a' : '#ef5350';
    const x = toX(i);

    // Wick
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, toY(c.high));
    ctx.lineTo(x, toY(c.low));
    ctx.stroke();

    // Body
    const bTop = toY(Math.max(c.open, c.close));
    const bBot = toY(Math.min(c.open, c.close));
    ctx.fillStyle = color;
    ctx.fillRect(x - bodyW / 2, bTop, bodyW, Math.max(1, bBot - bTop));
  }

  // Volume bars
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const bull = c.close >= c.open;
    ctx.fillStyle = bull ? 'rgba(38,166,154,0.45)' : 'rgba(239,83,80,0.45)';
    const x = toX(i);
    const vTop = toVolY(c.volume);
    ctx.fillRect(x - bodyW / 2, vTop, bodyW, volT + volH - vTop);
  }

  // Price labels (right axis)
  ctx.fillStyle = '#8b949e';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  for (let i = 0; i <= GRIDS; i++) {
    const p = maxP + pad - ((pRange + pad * 2) / GRIDS) * i;
    const y = cT + (priceH / GRIDS) * i;
    ctx.fillText(axisPrice(p), cR + 4, y + 4);
  }

  // Volume label
  ctx.fillStyle = '#485069';
  ctx.font = '9px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('VOL', cR + 4, volT + 10);

  // Time labels (bottom)
  ctx.fillStyle = '#8b949e';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  const tickEvery = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += tickEvery) {
    const c = candles[i];
    const x = toX(i);
    const d = new Date(c.time * 1000);
    const lbl = tf === '1d'
      ? `${(d.getMonth() + 1).toString().padStart(2,'0')}/${d.getDate().toString().padStart(2,'0')}`
      : `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
    ctx.fillText(lbl, x, H - PAD.bottom + 14);
    ctx.strokeStyle = '#21262d';
    ctx.beginPath(); ctx.moveTo(x, cB); ctx.lineTo(x, cB + 3); ctx.stroke();
  }

  // Title
  ctx.fillStyle = '#c9d1d9';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${symbol} — ${tf}`, W / 2, 24);

  // Border boxes
  ctx.strokeStyle = '#21262d';
  ctx.lineWidth = 1;
  ctx.strokeRect(cL, cT, cW, priceH);
  ctx.strokeRect(cL, volT, cW, volH);

  return canvas.toBuffer('image/png');
}

export function buildChartCaption(data: any, tf: string): string {
  const sym = data?.baseToken?.symbol ?? '?';
  const name = data?.baseToken?.name ?? sym;
  const priceUsd = parseFloat(data?.priceUsd ?? '0') || 0;
  const ch1h  = data?.priceChange?.h1  ?? 0;
  const ch24  = data?.priceChange?.h24 ?? 0;
  const vol   = data?.volume?.h24 ?? 0;
  const liq   = data?.liquidity?.usd ?? 0;
  const fdv   = data?.fdv ?? 0;

  const e1h  = ch1h  >= 0 ? '🟢' : '🔴';
  const e24  = ch24  >= 0 ? '🟢' : '🔴';
  const sign = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';

  function fmtUsdShort(v: number) {
    if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
    return `$${v.toFixed(0)}`;
  }

  return [
    `📊 <b>${name} ($${sym})</b> — ${tf}`,
    '',
    `💰 ${fmtPriceUsd(priceUsd)}${fdv ? `  |  MC: ${fmtUsdShort(fdv)}` : ''}`,
    `📈 1h: ${e1h} <b>${sign(ch1h)}</b>  |  24h: ${e24} <b>${sign(ch24)}</b>`,
    `💧 Liq: ${liq ? fmtUsdShort(liq) : 'N/A'}  ·  Vol: ${vol ? fmtUsdShort(vol) : 'N/A'}`,
  ].join('\n');
}
