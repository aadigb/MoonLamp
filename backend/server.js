import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const DATA_DIR         = path.join(__dirname, 'data');
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL_MS || '60000');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── Supabase (production) / file system (local) ────────────────────────────────

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  const { createClient } = await import('@supabase/supabase-js');
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  console.log('Storage: Supabase');
} else {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('Storage: local filesystem (set SUPABASE_URL + SUPABASE_SERVICE_KEY for production)');
}

// ── Price cache ────────────────────────────────────────────────────────────────

const priceCache  = new Map();
const searchCache = new Map();
const CRYPTO_TTL  = 15 * 60 * 1000;  // 15 min
const STOCK_TTL   = 15 * 60 * 1000;  // 15 min
const SEARCH_TTL  = 10 * 60 * 1000;  // 10 min — search results don't change often

function fromCache(key, ttl) {
  const hit = priceCache.get(key);
  return (hit && Date.now() - hit.ts < ttl) ? hit.data : null;
}
function toCache(key, data) { priceCache.set(key, { data, ts: Date.now() }); }

// ── Account helpers ────────────────────────────────────────────────────────────

function isValidId(id) {
  return id === 'default' || (typeof id === 'string' && UUID_RE.test(id));
}
function resolveId(req) {
  const id = (req.headers['x-account-id'] || req.query.account || 'default').trim();
  return isValidId(id) ? id : null;
}
function localAccountDir(id) {
  const dir = path.join(DATA_DIR, id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Config ─────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  mode: 'asset', assetType: 'crypto', asset: 'bitcoin',
  walletAddress: '', alertThreshold: 5, bundle: [],
  savedBundles: {}, activeBundleName: null,
  schedule: { enabled: false, startTime: '09:00', endTime: '22:00' },
};

const configCache = new Map();
const stateCache  = new Map();
const lastSeenMap = new Map();

async function loadConfig(id) {
  if (configCache.has(id)) return configCache.get(id);
  let cfg = { ...DEFAULT_CONFIG };
  if (supabase) {
    const { data } = await supabase.from('configs').select('data').eq('account_id', id).single();
    if (data) cfg = { ...DEFAULT_CONFIG, ...data.data };
  } else {
    try {
      const f = path.join(localAccountDir(id), 'config.json');
      if (fs.existsSync(f)) cfg = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(f, 'utf8')) };
    } catch {}
  }
  configCache.set(id, cfg);
  return cfg;
}

async function saveConfig(id, cfg) {
  configCache.set(id, cfg);
  if (supabase) {
    await supabase.from('configs').upsert({ account_id: id, data: cfg, updated_at: new Date().toISOString() });
  } else {
    fs.writeFileSync(path.join(localAccountDir(id), 'config.json'), JSON.stringify(cfg, null, 2));
  }
}

function getState(id)     { return stateCache.get(id) ?? { color: 'white', intensity: 0.2, alert: false, label: null, currentValue: null, percentChange: null, lastUpdated: null, error: null }; }
function setState(id, s)  { stateCache.set(id, s); }

// ── Moods ──────────────────────────────────────────────────────────────────────

async function loadMoods(id) {
  if (supabase) {
    const { data } = await supabase.from('moods')
      .select('mood, lamp_color, percent_change, created_at')
      .eq('account_id', id)
      .order('created_at', { ascending: false })
      .limit(20);
    return (data || []).map(r => ({
      mood: r.mood, timestamp: r.created_at,
      lampColor: r.lamp_color, percentChange: r.percent_change,
    }));
  }
  try {
    const f = path.join(localAccountDir(id), 'moods.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {}
  return [];
}

async function appendMood(id, mood) {
  const st = getState(id);
  if (supabase) {
    await supabase.from('moods').insert({
      account_id: id, mood,
      lamp_color: st.color, percent_change: st.percentChange,
    });
    return loadMoods(id);
  }
  const moods = await loadMoods(id);
  moods.unshift({ mood, timestamp: new Date().toISOString(), lampColor: st.color, percentChange: st.percentChange });
  if (moods.length > 200) moods.splice(200);
  fs.writeFileSync(path.join(localAccountDir(id), 'moods.json'), JSON.stringify(moods, null, 2));
  return moods.slice(0, 20);
}

// ── Migrate legacy data ────────────────────────────────────────────────────────

function migrateLegacy() {
  if (supabase) return; // not needed for cloud
  const legacyCfg   = path.join(__dirname, 'config.json');
  const legacyMoods = path.join(__dirname, 'moods.json');
  const defaultDir  = path.join(DATA_DIR, 'default');
  if (fs.existsSync(legacyCfg) && !fs.existsSync(path.join(defaultDir, 'config.json'))) {
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.copyFileSync(legacyCfg, path.join(defaultDir, 'config.json'));
  }
  if (fs.existsSync(legacyMoods) && !fs.existsSync(path.join(defaultDir, 'moods.json'))) {
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.copyFileSync(legacyMoods, path.join(defaultDir, 'moods.json'));
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function calcIntensity(pct, t) {
  if (pct == null) return 0.2;
  return Math.min(1.0, 0.2 + 0.8 * (Math.abs(pct) / (t > 0 ? t : 5)));
}
function calcAlert(pct, t) {
  return pct != null && Math.abs(pct) >= t;
}

function isWithinSchedule(schedule) {
  if (!schedule?.enabled) return true;
  const pst = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
  const [h, m] = pst.split(':').map(Number);
  const cur = h * 60 + m;
  const [sh, sm] = (schedule.startTime || '09:00').split(':').map(Number);
  const [eh, em] = (schedule.endTime || '22:00').split(':').map(Number);
  const s = sh * 60 + sm, e = eh * 60 + em;
  return s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e);
}

// ── Price fetching ─────────────────────────────────────────────────────────────

async function fetchCryptoData(coinId) {
  const cached = fromCache(`crypto:${coinId}`, CRYPTO_TTL);
  if (cached) return cached;
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd&include_24hr_change=true&include_market_cap=false`,
    { headers: { Accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const data = await res.json();
  if (!data[coinId]) throw new Error(`Coin not found: "${coinId}".`);
  const result = {
    label: coinId.charAt(0).toUpperCase() + coinId.slice(1),
    price: data[coinId].usd,
    change24h: data[coinId].usd_24h_change ?? null,
  };
  toCache(`crypto:${coinId}`, result);
  return result;
}

async function fetchStockData(ticker) {
  const sym = ticker.toUpperCase();
  const cached = fromCache(`stock:${sym}`, STOCK_TTL);
  if (cached) return cached;
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2d`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status} for ${sym}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Ticker not found: "${sym}"`);
  const meta = result.meta;
  const price = meta.regularMarketPrice;
  const prev  = meta.chartPreviousClose ?? meta.previousClose;
  const out = {
    label: meta.longName || meta.shortName || sym,
    price,
    change24h: (price != null && prev) ? ((price - prev) / prev) * 100 : null,
  };
  toCache(`stock:${sym}`, out);
  return out;
}

async function fetchWalletData(address) {
  const { default: fetch } = await import('node-fetch');
  const apiKey = process.env.ZERION_API_KEY;
  if (!apiKey) throw new Error('ZERION_API_KEY not set.');
  const res = await fetch(
    `https://api.zerion.io/v1/wallets/${address}/portfolio/?currency=usd`,
    { headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`, Accept: 'application/json' } }
  );
  if (res.status === 401) throw new Error('Zerion API key invalid.');
  if (res.status === 429) throw new Error('Zerion rate limit.');
  if (!res.ok) throw new Error(`Zerion HTTP ${res.status}`);
  const json = await res.json();
  const attrs = json?.data?.attributes;
  if (!attrs) throw new Error('Unexpected Zerion response.');
  const chains = attrs.positions_distribution_by_chain ?? {};
  const topChains = Object.entries(chains).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([c, v]) => `${c}: $${v.toFixed(0)}`).join(' · ');
  return {
    label: `${address.slice(0, 6)}…${address.slice(-4)}`,
    price: attrs.total?.positions ?? 0,
    change24h: attrs.changes?.percent_1d ?? null,
    detail: topChains,
  };
}

async function fetchBundleData(bundle) {
  if (!bundle?.length) throw new Error('Bundle is empty.');
  const totalWeight = bundle.reduce((s, b) => s + b.weight, 0);
  if (!totalWeight) throw new Error('Bundle weights sum to zero.');
  const { default: fetch } = await import('node-fetch');

  const cryptoItems = bundle.filter(b => b.type === 'crypto');
  const stockItems  = bundle.filter(b => b.type === 'stock');

  const cryptoMap = {};
  if (cryptoItems.length) {
    const uncached = cryptoItems.filter(b => !fromCache(`crypto:${b.asset}`, CRYPTO_TTL));
    if (uncached.length) {
      const ids = uncached.map(b => encodeURIComponent(b.asset)).join(',');
      const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
      const fresh = await res.json();
      for (const [id, d] of Object.entries(fresh)) {
        toCache(`crypto:${id}`, { label: id.charAt(0).toUpperCase() + id.slice(1), price: d.usd, change24h: d.usd_24h_change ?? null });
        cryptoMap[id] = d;
      }
    }
    for (const item of cryptoItems) {
      if (!cryptoMap[item.asset]) {
        const c = fromCache(`crypto:${item.asset}`, CRYPTO_TTL);
        if (c) cryptoMap[item.asset] = { usd: c.price, usd_24h_change: c.change24h };
      }
    }
  }

  const stockResults = [];
  for (const item of stockItems) {
    stockResults.push(await fetchStockData(item.asset));
    if (stockItems.length > 1) await new Promise(r => setTimeout(r, 300));
  }

  const results = bundle.map(item => {
    const normWeight = item.weight / totalWeight;
    if (item.type === 'crypto') {
      const d = cryptoMap[item.asset];
      if (!d) throw new Error(`Coin not found: "${item.asset}"`);
      return { label: item.label || item.asset, change24h: d.usd_24h_change ?? null, normWeight };
    }
    const d = stockResults.find(r => r.label.toUpperCase() === item.asset.toUpperCase());
    return { label: item.label || item.asset, change24h: d?.change24h ?? null, normWeight };
  });

  const weightedChange = results.reduce((s, r) => s + (r.change24h ?? 0) * r.normWeight, 0);
  return {
    label: 'BUNDLE', price: null, change24h: weightedChange,
    detail: results.map(r => `${r.label.toUpperCase()}: ${r.change24h != null ? r.change24h.toFixed(2) + '%' : '?'}`).join(' · '),
  };
}

// ── Update state ───────────────────────────────────────────────────────────────

async function updateState(id) {
  const cfg = await loadConfig(id);
  try {
    let result;
    if (cfg.mode === 'asset') {
      result = cfg.assetType === 'crypto' ? await fetchCryptoData(cfg.asset) : await fetchStockData(cfg.asset);
    } else if (cfg.mode === 'wallet') {
      if (!cfg.walletAddress) throw new Error('No wallet address configured.');
      result = await fetchWalletData(cfg.walletAddress);
    } else if (cfg.mode === 'bundle') {
      const items = (cfg.activeBundleName && cfg.savedBundles?.[cfg.activeBundleName])
        ? cfg.savedBundles[cfg.activeBundleName] : cfg.bundle || [];
      result = await fetchBundleData(items);
      if (cfg.activeBundleName) result.label = cfg.activeBundleName;
    } else {
      throw new Error(`Unknown mode: ${cfg.mode}`);
    }
    const { label, price, change24h } = result;
    setState(id, {
      color: change24h == null ? 'white' : change24h >= 0 ? 'green' : 'red',
      intensity: calcIntensity(change24h, cfg.alertThreshold),
      alert: calcAlert(change24h, cfg.alertThreshold),
      label, currentValue: price, percentChange: change24h,
      lastUpdated: new Date().toISOString(), error: null,
      ...(result.detail ? { detail: result.detail } : {}),
    });
    console.log(`[${id.slice(0,8)}] ${label}: ${change24h?.toFixed(2) ?? '?'}% → ${getState(id).color.toUpperCase()}`);
  } catch (err) {
    console.error(`[${id.slice(0,8)}] Update failed:`, err.message);
    setState(id, { ...getState(id), error: err.message, color: 'white', intensity: 0.2, alert: false, lastUpdated: new Date().toISOString() });
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────────

app.get('/api/account/new', (_req, res) => res.json({ id: randomUUID() }));

app.get('/api/color', async (req, res) => {
  const id = resolveId(req) || 'default';
  lastSeenMap.set(id, Date.now());
  const cfg = await loadConfig(id);
  if (!isWithinSchedule(cfg.schedule)) return res.json({ color: 'off', intensity: 0, alert: false });
  res.json({ color: getState(id).color, intensity: getState(id).intensity, alert: getState(id).alert });
});

app.get('/api/status', async (req, res) => {
  const id = resolveId(req);
  if (!id) return res.status(400).json({ error: 'Invalid account ID.' });
  lastSeenMap.set(id, Date.now());
  if (!stateCache.has(id)) await updateState(id);
  res.json({ state: getState(id), config: await loadConfig(id) });
});

app.post('/api/config', async (req, res) => {
  const id = resolveId(req);
  if (!id) return res.status(400).json({ error: 'Invalid account ID.' });
  lastSeenMap.set(id, Date.now());
  const cfg = await loadConfig(id);
  const { mode, assetType, asset, walletAddress, alertThreshold, bundle, savedBundles, activeBundleName, schedule } = req.body;
  if (mode !== undefined)             cfg.mode = mode;
  if (assetType !== undefined)        cfg.assetType = assetType;
  if (asset !== undefined)            cfg.asset = asset.trim().toLowerCase();
  if (walletAddress !== undefined)    cfg.walletAddress = walletAddress.trim();
  if (alertThreshold !== undefined) { const t = parseFloat(alertThreshold); if (!isNaN(t) && t > 0) cfg.alertThreshold = t; }
  if (bundle !== undefined)           cfg.bundle = bundle;
  if (savedBundles !== undefined)     cfg.savedBundles = savedBundles;
  if (activeBundleName !== undefined) cfg.activeBundleName = activeBundleName;
  if (schedule !== undefined)         cfg.schedule = schedule;
  await saveConfig(id, cfg);
  await updateState(id);
  res.json({ ok: true, state: getState(id), config: cfg });
});

app.get('/api/search/crypto', async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    const hit = searchCache.get(q);
    if (hit && Date.now() - hit.ts < SEARCH_TTL) return res.json(hit.data);
    const { default: fetch } = await import('node-fetch');
    const r = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`);
    if (!r.ok) throw new Error(`CoinGecko search HTTP ${r.status}`);
    const data = await r.json();
    const result = (data.coins || []).slice(0, 8).map(c => ({ id: c.id, name: c.name, symbol: c.symbol.toUpperCase(), thumb: c.thumb }));
    searchCache.set(q, { data: result, ts: Date.now() });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mood', async (req, res) => {
  const id = resolveId(req);
  if (!id) return res.status(400).json({ error: 'Invalid account ID.' });
  const { mood } = req.body;
  if (!mood) return res.status(400).json({ error: 'mood required' });
  res.json({ ok: true, recent: await appendMood(id, mood) });
});

app.get('/api/moods', async (req, res) => {
  const id = resolveId(req);
  if (!id) return res.status(400).json({ error: 'Invalid account ID.' });
  res.json(await loadMoods(id));
});

// ── Boot ───────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000');
app.listen(PORT, () => {
  console.log(`Moonlamp server → http://localhost:${PORT}`);
  migrateLegacy();
  updateState('default');
  setInterval(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, ts] of lastSeenMap.entries()) {
      if (ts > cutoff) updateState(id);
    }
    updateState('default');
  }, REFRESH_INTERVAL);
});
