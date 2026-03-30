// ── State ─────────────────────────────────────────────────────────────────────

let currentMode = 'asset';
let currentAssetType = 'crypto';
let selectedCoinId = null;
let searchDebounce = null;

// ── Boot ──────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  fetchStatus();
  setInterval(fetchStatus, 30_000);
  showLocalIp();
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) closeDropdown();
  });
});

// ── Status polling ────────────────────────────────────────────────────────────

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const { state, config } = await res.json();
    renderStatus(state);
    syncFormToConfig(config);
    hideError();
  } catch {
    showError('Cannot reach server. Make sure the backend is running.');
  }
}

function renderStatus(state) {
  const { color, intensity, alert, label, currentValue, percentChange, lastUpdated, error, detail } = state;

  // ── Lamp glow — scale glow radius with intensity ──
  const lamp = document.getElementById('lampIcon');
  lamp.className = `lamp-icon ${color}`;
  if (intensity && color !== 'white') {
    const glowSize = Math.round(10 + intensity * 60); // 10px → 70px
    const col = color === 'green' ? 'var(--green)' : 'var(--red)';
    lamp.style.textShadow = `0 0 ${glowSize}px ${col}, 0 0 ${glowSize * 2}px ${col}`;
  } else {
    lamp.style.textShadow = '';
  }

  // ── Status dot ──
  const dot = document.getElementById('statusDot');
  dot.className = `status-dot ${color}${alert ? ' alert-active' : ''}`;

  // ── Alert badge ──
  const badge = document.getElementById('alertBadge');
  if (alert && color !== 'white') {
    badge.style.display = 'block';
    badge.textContent = 'ALERT';
    badge.className = `alert-badge${color === 'green' ? ' green-alert' : ''}`;
  } else {
    badge.style.display = 'none';
  }

  // ── Intensity bar ──
  const intensityCard = document.getElementById('intensityCard');
  const intensityFill = document.getElementById('intensityFill');
  const intensityValue = document.getElementById('intensityValue');
  if (percentChange !== null && percentChange !== undefined && color !== 'white') {
    intensityCard.style.display = 'block';
    intensityFill.style.width = `${Math.round((intensity ?? 0.2) * 100)}%`;
    intensityFill.className = `intensity-fill ${color}`;
    intensityValue.textContent = `${Math.round((intensity ?? 0.2) * 100)}% signal · ${Math.abs(percentChange).toFixed(2)}% move`;
  } else {
    intensityCard.style.display = 'none';
  }

  // ── Label ──
  document.getElementById('statusLabel').textContent = label || '—';

  // ── Value ──
  const valEl = document.getElementById('statusValue');
  if (currentValue !== null && currentValue !== undefined) {
    valEl.textContent = `$${formatNumber(currentValue)}`;
  } else if (error) {
    valEl.textContent = 'Error';
  } else {
    valEl.textContent = '—';
  }

  // ── Change ──
  const changeEl = document.getElementById('statusChange');
  if (percentChange !== null && percentChange !== undefined) {
    const sign = percentChange >= 0 ? '+' : '';
    changeEl.textContent = `${sign}${percentChange.toFixed(2)}% (24h)`;
    changeEl.className = `status-change ${percentChange >= 0 ? 'positive' : 'negative'}`;
  } else {
    changeEl.textContent = '';
    changeEl.className = 'status-change';
  }

  // ── Detail line (portfolio chain breakdown, token counts, etc.) ──
  document.getElementById('statusDetail').textContent = detail || '';

  // ── Timestamp ──
  if (lastUpdated) {
    document.getElementById('statusTime').textContent = new Date(lastUpdated).toLocaleTimeString();
  }

  if (error) showError(error);
}

function syncFormToConfig(config) {
  // Sync mode tabs
  if (currentMode !== config.mode) switchMode(config.mode, false);

  // Sync asset type tabs
  if (config.mode === 'asset') {
    if (currentAssetType !== config.assetType) switchAssetType(config.assetType, false);
    if (config.assetType === 'crypto' && config.asset) {
      const input = document.getElementById('cryptoSearch');
      if (!input.value) { input.value = config.asset; selectedCoinId = config.asset; }
    }
    if (config.assetType === 'stock' && config.asset) {
      const input = document.getElementById('stockTicker');
      if (!input.value) input.value = config.asset.toUpperCase();
    }
  } else {
    const input = document.getElementById('walletInput');
    if (!input.value && config.walletAddress) input.value = config.walletAddress;
  }

  // Sync threshold slider
  if (config.alertThreshold !== undefined) {
    const slider = document.getElementById('thresholdSlider');
    const display = document.getElementById('thresholdDisplay');
    slider.value = config.alertThreshold;
    display.textContent = `${config.alertThreshold}%`;
  }
}

// ── Mode switching ────────────────────────────────────────────────────────────

function switchMode(mode, updateDom = true) {
  currentMode = mode;
  if (!updateDom) return;
  document.getElementById('tabAsset').classList.toggle('active', mode === 'asset');
  document.getElementById('tabWallet').classList.toggle('active', mode === 'wallet');
  document.getElementById('panelAsset').style.display = mode === 'asset' ? '' : 'none';
  document.getElementById('panelWallet').style.display = mode === 'wallet' ? '' : 'none';
}

function switchAssetType(type, updateDom = true) {
  currentAssetType = type;
  if (!updateDom) return;
  document.getElementById('tabCrypto').classList.toggle('active', type === 'crypto');
  document.getElementById('tabStock').classList.toggle('active', type === 'stock');
  document.getElementById('cryptoInput').style.display = type === 'crypto' ? '' : 'none';
  document.getElementById('stockInput').style.display = type === 'stock' ? '' : 'none';
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
    const res = await fetch(`/api/search/crypto?q=${encodeURIComponent(query)}`);
    const coins = await res.json();
    if (!coins.length) { closeDropdown(); return; }
    renderDropdown(coins);
  } catch {
    closeDropdown();
  }
}

function renderDropdown(coins) {
  const dd = document.getElementById('cryptoDropdown');
  dd.innerHTML = coins.map((c) => `
    <div class="dropdown-item" onclick="selectCoin('${c.id}', '${escHtml(c.name)}')">
      ${c.thumb ? `<img src="${c.thumb}" alt="" />` : '<div style="width:22px"></div>'}
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
    if (!coinId) { showError('Please search for and select a cryptocurrency.'); return; }
    body = { mode: 'asset', assetType: 'crypto', asset: coinId };
  } else {
    const ticker = document.getElementById('stockTicker').value.trim();
    if (!ticker) { showError('Please enter a stock ticker (e.g. AAPL).'); return; }
    body = { mode: 'asset', assetType: 'stock', asset: ticker };
  }

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.state?.error) showError(data.state.error);
    else renderStatus(data.state);
  } catch (err) {
    showError('Failed to save: ' + err.message);
  }
}

async function saveWallet() {
  hideError();
  const addr = document.getElementById('walletInput').value.trim();
  if (!addr || !addr.startsWith('0x') || addr.length !== 42) {
    showError('Please enter a valid EVM address (0x… 42 characters).');
    return;
  }
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'wallet', walletAddress: addr }),
    });
    const data = await res.json();
    if (data.state?.error) showError(data.state.error);
    else renderStatus(data.state);
  } catch (err) {
    showError('Failed to save: ' + err.message);
  }
}

// ── Threshold ─────────────────────────────────────────────────────────────────

function onThresholdChange(val) {
  document.getElementById('thresholdDisplay').textContent = `${parseFloat(val)}%`;
}

async function saveThreshold() {
  hideError();
  const val = parseFloat(document.getElementById('thresholdSlider').value);
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertThreshold: val }),
    });
    const data = await res.json();
    if (data.state?.error) showError(data.state.error);
    else renderStatus(data.state);
  } catch (err) {
    showError('Failed to save threshold: ' + err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatNumber(n) {
  if (n >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(6);
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showError(msg) {
  const el = document.getElementById('errorBox');
  el.textContent = msg;
  el.style.display = 'block';
}

function hideError() {
  document.getElementById('errorBox').style.display = 'none';
}

function showLocalIp() {
  const host = window.location.hostname;
  const port = window.location.port || '3000';
  const el = document.getElementById('localIp');
  if (el) {
    el.textContent = host === 'localhost' || host === '127.0.0.1'
      ? 'Run ipconfig (Windows) to find your local IP'
      : host;
    const epEl = document.getElementById('espEndpoint');
    if (epEl) epEl.textContent = `http://${host}:${port}/api/color`;
  }
}
