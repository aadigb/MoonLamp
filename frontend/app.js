// ── State ─────────────────────────────────────────────────────────────────────

let currentMode      = 'asset';
let currentAssetType = 'crypto';
let selectedCoinId   = null;
let searchDebounce   = null;

// ── Boot ──────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  spawnStars();
  fetchStatus();
  setInterval(fetchStatus, 30_000);
  showLocalIp();
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) closeDropdown();
  });
});

// ── Stars ─────────────────────────────────────────────────────────────────────

function spawnStars() {
  const container = document.getElementById('stars');
  if (!container) return;
  // ✦ = 4-pointed star (most), ✶ = 6-pointed (occasional accent)
  const glyphs = ['✦','✦','✦','✦','✦','✶','✦','✦'];
  for (let i = 0; i < 55; i++) {
    const el   = document.createElement('span');
    el.className   = 'star';
    el.textContent = glyphs[Math.floor(Math.random() * glyphs.length)];
    const size = Math.random() < 0.15 ? (10 + Math.random() * 8) : (5 + Math.random() * 6);
    el.style.cssText = `
      left:      ${Math.random() * 100}vw;
      top:       ${Math.random() * 100}vh;
      font-size: ${size}px;
      --dur:     ${2.5 + Math.random() * 5}s;
      --delay:   ${-Math.random() * 7}s;
      opacity:   0;
    `;
    container.appendChild(el);
  }
}

// ── Status polling ────────────────────────────────────────────────────────────

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const { state, config } = await res.json();
    renderStatus(state);
    syncFormToConfig(config);
    setConnected(true);
    hideError();
  } catch {
    setConnected(false);
    showError('Cannot reach server. Make sure the backend is running (npm start).');
  }
}

function setConnected(online) {
  const led  = document.getElementById('connLed');
  const text = document.getElementById('connText');
  if (!led) return;
  led.className  = `conn-led${online ? ' online' : ''}`;
  text.textContent = online ? 'CONNECTED' : 'OFFLINE';
}

// ── Render status ─────────────────────────────────────────────────────────────

function renderStatus(state) {
  const { color, intensity, alert, label, currentValue, percentChange, lastUpdated, error, detail } = state;

  // Lamp glow (filter controlled by CSS class)
  const lamp = document.getElementById('lampIcon');
  lamp.className = `lamp-icon ${color}`;

  // Status dot
  const dot = document.getElementById('statusDot');
  dot.className = `status-dot ${color}${alert ? ' alert-active' : ''}`;

  // Alert badge
  const badge = document.getElementById('alertBadge');
  if (alert && color !== 'white') {
    badge.style.display = 'block';
    badge.textContent   = '!ALERT';
    badge.className     = `alert-badge${color === 'green' ? ' green-alert' : ''}`;
  } else {
    badge.style.display = 'none';
  }

  // Label
  document.getElementById('statusLabel').textContent =
    label ? `TRACKING: ${label.toUpperCase()}` : 'TRACKING: —';

  // Value — VT323 font + color class for glow
  const valEl = document.getElementById('statusValue');
  if (currentValue !== null && currentValue !== undefined) {
    valEl.textContent = `$${formatNumber(currentValue)}`;
    valEl.className   = `status-value${color !== 'white' ? ' ' + color : ''}`;
  } else if (error) {
    valEl.textContent = 'ERR';
    valEl.className   = 'status-value red';
  } else {
    valEl.textContent = 'LOADING...';
    valEl.className   = 'status-value';
  }

  // Change line
  const changeEl = document.getElementById('statusChange');
  if (percentChange !== null && percentChange !== undefined) {
    const sign = percentChange >= 0 ? '▲ +' : '▼ ';
    changeEl.textContent = `${sign}${percentChange.toFixed(2)}% (24H)`;
    changeEl.className   = `status-change ${percentChange >= 0 ? 'positive' : 'negative'}`;
  } else {
    changeEl.textContent = '';
    changeEl.className   = 'status-change';
  }

  // Detail line (portfolio chain breakdown, etc.)
  document.getElementById('statusDetail').textContent = detail || '';

  // Timestamp
  if (lastUpdated) {
    document.getElementById('statusTime').textContent =
      new Date(lastUpdated).toLocaleTimeString();
  }

  // EQ meter
  const intensityCard = document.getElementById('intensityCard');
  if (percentChange !== null && percentChange !== undefined && color !== 'white') {
    intensityCard.style.display = 'block';
    renderEqMeter(intensity ?? 0.2, color);
    document.getElementById('intensityValue').textContent =
      `${Math.round((intensity ?? 0.2) * 100)}% SIGNAL · ${Math.abs(percentChange).toFixed(2)}% MOVE`;
  } else {
    intensityCard.style.display = 'none';
  }

  if (error) showError(error);
}

// ── EQ Meter — 16 segments matching NeoPixel Ring 16 ─────────────────────────

function renderEqMeter(intensity, color) {
  const container = document.getElementById('eqBars');
  if (!container) return;
  const N      = 16;
  const active = Math.round(intensity * N);
  let   html   = '';

  for (let i = 0; i < N; i++) {
    const isActive = i < active;
    const ratio    = i / (N - 1); // 0 → 1 left to right

    let bg = '';
    if (isActive) {
      if (color === 'red') {
        // Pink → hot pink
        bg = ratio < 0.6 ? '#ff4477' : '#ff0080';
      } else {
        // Green → yellow → orange (like a real VU meter)
        bg = ratio < 0.625 ? '#00ff41' : ratio < 0.875 ? '#ffe600' : '#ff8800';
      }
    }

    html += `<div class="eq-seg${isActive ? ' active' : ''}" style="${
      isActive ? `background:${bg};box-shadow:0 0 5px ${bg};animation-delay:${i * 0.04}s` : ''
    }"></div>`;
  }

  container.innerHTML = html;
}

// ── Sync form to config ───────────────────────────────────────────────────────

function syncFormToConfig(config) {
  if (currentMode !== config.mode) switchMode(config.mode, false);
  if (config.mode === 'asset') {
    if (currentAssetType !== config.assetType) switchAssetType(config.assetType, false);
    if (config.assetType === 'crypto' && config.asset) {
      const el = document.getElementById('cryptoSearch');
      if (!el.value) { el.value = config.asset; selectedCoinId = config.asset; }
    }
    if (config.assetType === 'stock' && config.asset) {
      const el = document.getElementById('stockTicker');
      if (!el.value) el.value = config.asset.toUpperCase();
    }
  } else {
    const el = document.getElementById('walletInput');
    if (!el.value && config.walletAddress) el.value = config.walletAddress;
  }
  if (config.alertThreshold !== undefined) {
    document.getElementById('thresholdSlider').value = config.alertThreshold;
    document.getElementById('thresholdDisplay').textContent = `${config.alertThreshold}%`;
  }
}

// ── Mode switching ────────────────────────────────────────────────────────────

function switchMode(mode, dom = true) {
  currentMode = mode;
  if (!dom) return;
  document.getElementById('tabAsset').classList.toggle('active', mode === 'asset');
  document.getElementById('tabWallet').classList.toggle('active', mode === 'wallet');
  document.getElementById('panelAsset').style.display  = mode === 'asset'  ? '' : 'none';
  document.getElementById('panelWallet').style.display = mode === 'wallet' ? '' : 'none';
}

function switchAssetType(type, dom = true) {
  currentAssetType = type;
  if (!dom) return;
  document.getElementById('tabCrypto').classList.toggle('active', type === 'crypto');
  document.getElementById('tabStock').classList.toggle('active', type === 'stock');
  document.getElementById('cryptoInput').style.display = type === 'crypto' ? '' : 'none';
  document.getElementById('stockInput').style.display  = type === 'stock'  ? '' : 'none';
}

// ── Crypto search ─────────────────────────────────────────────────────────────

function onCryptoSearch(val) {
  selectedCoinId = null;
  document.getElementById('cryptoHint').textContent = '';
  clearTimeout(searchDebounce);
  if (!val.trim()) { closeDropdown(); return; }
  searchDebounce = setTimeout(() => searchCoins(val), 350);
}

async function searchCoins(query) {
  try {
    const res   = await fetch(`/api/search/crypto?q=${encodeURIComponent(query)}`);
    const coins = await res.json();
    if (!coins.length) { closeDropdown(); return; }
    renderDropdown(coins);
  } catch { closeDropdown(); }
}

function renderDropdown(coins) {
  const dd = document.getElementById('cryptoDropdown');
  dd.innerHTML = coins.map((c) => `
    <div class="dropdown-item" onclick="selectCoin('${c.id}', '${escHtml(c.name)}')">
      ${c.thumb ? `<img src="${c.thumb}" alt="" />` : '<div style="width:18px"></div>'}
      <span class="dropdown-item-name">${escHtml(c.name)}</span>
      <span class="dropdown-item-symbol">${c.symbol}</span>
    </div>
  `).join('');
  dd.classList.add('open');
}

function selectCoin(id, name) {
  selectedCoinId = id;
  document.getElementById('cryptoSearch').value = name;
  document.getElementById('cryptoHint').textContent = `ID: ${id}`;
  closeDropdown();
}

function closeDropdown() {
  document.getElementById('cryptoDropdown').classList.remove('open');
}

// ── Save actions ──────────────────────────────────────────────────────────────

async function saveAsset() {
  hideError();
  let body;
  if (currentAssetType === 'crypto') {
    const coinId = selectedCoinId || document.getElementById('cryptoSearch').value.trim().toLowerCase();
    if (!coinId) { showError('Search and select a cryptocurrency first.'); return; }
    body = { mode: 'asset', assetType: 'crypto', asset: coinId };
  } else {
    const ticker = document.getElementById('stockTicker').value.trim();
    if (!ticker) { showError('Enter a stock ticker (e.g. AAPL).'); return; }
    body = { mode: 'asset', assetType: 'stock', asset: ticker };
  }
  await postConfig(body);
}

async function saveWallet() {
  hideError();
  const addr = document.getElementById('walletInput').value.trim();
  if (!addr || !addr.startsWith('0x') || addr.length !== 42) {
    showError('Enter a valid EVM address (0x... 42 characters).');
    return;
  }
  await postConfig({ mode: 'wallet', walletAddress: addr });
}

async function saveThreshold() {
  hideError();
  const val = parseFloat(document.getElementById('thresholdSlider').value);
  await postConfig({ alertThreshold: val });
}

async function postConfig(body) {
  try {
    const res  = await fetch('/api/config', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json();
    if (data.state?.error) showError(data.state.error);
    else renderStatus(data.state);
  } catch (err) {
    showError('Request failed: ' + err.message);
  }
}

// ── Threshold slider ──────────────────────────────────────────────────────────

function onThresholdChange(val) {
  document.getElementById('thresholdDisplay').textContent = `${parseFloat(val)}%`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatNumber(n) {
  if (n >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1)    return n.toFixed(2);
  return n.toFixed(6);
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showError(msg) {
  const el = document.getElementById('errorBox');
  el.textContent   = msg;
  el.style.display = 'block';
}

function hideError() {
  document.getElementById('errorBox').style.display = 'none';
}

function showLocalIp() {
  const host = window.location.hostname;
  const port = window.location.port || '3000';
  const ipEl = document.getElementById('localIp');
  const epEl = document.getElementById('espEndpoint');
  if (ipEl) {
    ipEl.textContent = (host === 'localhost' || host === '127.0.0.1')
      ? 'run ipconfig (Windows) to find your LAN IP'
      : host;
  }
  if (epEl) epEl.textContent = `http://${host}:${port}/api/color`;
}
