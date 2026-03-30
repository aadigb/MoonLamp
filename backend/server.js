import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import yahooFinance from 'yahoo-finance2';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const CONFIG_FILE = path.join(__dirname, 'config.json');
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL_MS || '60000');

// ── State ──────────────────────────────────────────────────────────────────────

/** Persisted user config */
let config = {
  mode: 'asset',          // 'asset' | 'wallet'
  assetType: 'crypto',    // 'crypto' | 'stock'
  asset: 'bitcoin',      // CoinGecko ID for crypto, ticker for stock
  walletAddress: '',      // EVM address (0x...)
  alertThreshold: 5,      // % change that triggers alert flash (default 5%)
};

/**
 * Current lamp state — read by ESP32 and the UI.
 *
 * intensity: 0.0–1.0
 *   Scales linearly from 0.2 (flat/unknown) to 1.0 at alertThreshold.
 *   Controls NeoPixel brightness on the ESP32.
 *
 * alert: true when |percentChange| >= alertThreshold
 *   ESP32 switches from slow breathe to rapid flash.
 */
let state = {
  color: 'white',
  intensity: 0.2,
  alert: false,
  label: null,
  currentValue: null,
  percentChange: null,
  lastUpdated: null,
  error: null,
};

// ── Config persistence ─────────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
      console.log('Config loaded:', config);
    }
  } catch (e) {
    console.error('Failed to load config:', e.message);
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ── Intensity & alert helpers ──────────────────────────────────────────────────

/**
 * Maps |percentChange| to a 0.2–1.0 brightness value.
 * Reaches 1.0 at alertThreshold and stays capped there.
 */
function calcIntensity(percentChange, threshold) {
  if (percentChange === null || percentChange === undefined) return 0.2;
  const abs = Math.abs(percentChange);
  const t = threshold > 0 ? threshold : 5;
  return Math.min(1.0, 0.2 + 0.8 * (abs / t));
}

function calcAlert(percentChange, threshold) {
  if (percentChange === null || percentChange === undefined) return false;
  return Math.abs(percentChange) >= threshold;
}

// ── Price fetching ─────────────────────────────────────────────────────────────

async function fetchCryptoData(coinId) {
  const { default: fetch } = await import('node-fetch');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd&include_24hr_change=true&include_market_cap=false`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const data = await res.json();
  if (!data[coinId]) throw new Error(`Coin not found: "${coinId}". Use the CoinGecko ID (e.g. "bitcoin", "ethereum", "solana").`);
  return {
    label: coinId.charAt(0).toUpperCase() + coinId.slice(1),
    price: data[coinId].usd,
    change24h: data[coinId].usd_24h_change ?? null,
  };
}

async function fetchStockData(ticker) {
  const quote = await yahooFinance.quote(ticker.toUpperCase());
  return {
    label: quote.shortName || ticker.toUpperCase(),
    price: quote.regularMarketPrice,
    change24h: quote.regularMarketChangePercent ?? null,
  };
}

/**
 * Zerion Portfolio API
 * Docs: https://developers.zerion.io/api-reference/wallets/get-wallet-portfolio
 *
 * Returns real 24h % change across the FULL multi-token portfolio —
 * not just ETH, not just estimated. This is what makes Zerion great here.
 */
async function fetchWalletData(address) {
  const { default: fetch } = await import('node-fetch');
  const apiKey = process.env.ZERION_API_KEY;
  if (!apiKey) throw new Error('ZERION_API_KEY not set in .env');

  const authHeader = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;

  const res = await fetch(
    `https://api.zerion.io/v1/wallets/${address}/portfolio/?currency=usd`,
    {
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    }
  );

  if (res.status === 401) throw new Error('Zerion API key is invalid or expired.');
  if (res.status === 429) throw new Error('Zerion rate limit hit — will retry next cycle.');
  if (!res.ok) throw new Error(`Zerion HTTP ${res.status}`);

  const json = await res.json();
  const attrs = json?.data?.attributes;
  if (!attrs) throw new Error('Unexpected Zerion response shape.');

  const totalValue = attrs.total?.positions ?? 0;
  const change24h = attrs.changes?.percent_1d ?? null;
  const shortAddr = `${address.slice(0, 6)}…${address.slice(-4)}`;

  // Build a chain breakdown detail string
  const chains = attrs.positions_distribution_by_chain ?? {};
  const topChains = Object.entries(chains)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([chain, val]) => `${chain}: $${val.toFixed(0)}`)
    .join(' · ');

  return {
    label: shortAddr,
    price: totalValue,
    change24h,
    detail: topChains || `$${totalValue.toFixed(2)} portfolio`,
  };
}

// ── Main update loop ───────────────────────────────────────────────────────────

async function updateState() {
  try {
    let result;
    if (config.mode === 'asset') {
      result = config.assetType === 'crypto'
        ? await fetchCryptoData(config.asset)
        : await fetchStockData(config.asset);
    } else {
      if (!config.walletAddress) throw new Error('No wallet address configured.');
      result = await fetchWalletData(config.walletAddress);
    }

    const { label, price, change24h } = result;
    const intensity = calcIntensity(change24h, config.alertThreshold);
    const alert = calcAlert(change24h, config.alertThreshold);

    state = {
      color: change24h === null ? 'white' : change24h >= 0 ? 'green' : 'red',
      intensity,
      alert,
      label,
      currentValue: price,
      percentChange: change24h,
      lastUpdated: new Date().toISOString(),
      error: null,
      ...(result.detail ? { detail: result.detail } : {}),
    };

    console.log(
      `[${state.lastUpdated}] ${label}: ${change24h?.toFixed(2) ?? '?'}% → ${state.color.toUpperCase()}` +
      ` (intensity=${intensity.toFixed(2)}, alert=${alert})`
    );
  } catch (err) {
    console.error('Update failed:', err.message);
    state = {
      ...state,
      error: err.message,
      color: 'white',
      intensity: 0.2,
      alert: false,
      lastUpdated: new Date().toISOString(),
    };
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────────

/**
 * ESP32 polls this every 60s.
 * Compact response — only what the firmware needs.
 */
app.get('/api/color', (_req, res) => {
  res.json({
    color: state.color,
    intensity: state.intensity,
    alert: state.alert,
  });
});

/** Full status for the UI */
app.get('/api/status', (_req, res) => {
  res.json({ state, config });
});

/** Update config and trigger immediate refresh */
app.post('/api/config', async (req, res) => {
  const { mode, assetType, asset, walletAddress, alertThreshold } = req.body;
  if (mode !== undefined) config.mode = mode;
  if (assetType !== undefined) config.assetType = assetType;
  if (asset !== undefined) config.asset = asset.trim().toLowerCase();
  if (walletAddress !== undefined) config.walletAddress = walletAddress.trim();
  if (alertThreshold !== undefined) {
    const t = parseFloat(alertThreshold);
    if (!isNaN(t) && t > 0) config.alertThreshold = t;
  }

  saveConfig();
  await updateState();
  res.json({ ok: true, state, config });
});

/** Search CoinGecko for coin IDs */
app.get('/api/search/crypto', async (req, res) => {
  try {
    const { default: fetch } = await import('node-fetch');
    const q = encodeURIComponent(req.query.q || '');
    const r = await fetch(`https://api.coingecko.com/api/v3/search?query=${q}`);
    const data = await r.json();
    res.json(
      (data.coins || []).slice(0, 8).map((c) => ({
        id: c.id,
        name: c.name,
        symbol: c.symbol.toUpperCase(),
        thumb: c.thumb,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000');
app.listen(PORT, () => {
  console.log(`Moonlamp server → http://localhost:${PORT}`);
  loadConfig();
  updateState();
  setInterval(updateState, REFRESH_INTERVAL);
});
