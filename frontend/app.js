// ── Account (anonymous, UUID stored in localStorage) ─────────────────────────

function getAccountId() {
  let id = localStorage.getItem('moonlamp_account_id');
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    id = crypto.randomUUID();
    localStorage.setItem('moonlamp_account_id', id);
  }
  return id;
}

const ACCOUNT_ID = getAccountId();

// All API calls go through here — always includes account header
async function apiFetch(url, opts = {}) {
  opts.headers = { ...(opts.headers || {}), 'x-account-id': ACCOUNT_ID };
  return fetch(url, opts);
}

// ── State ─────────────────────────────────────────────────────────────────────

let currentMode      = 'asset';
let currentAssetType = 'crypto';
let selectedCoinId   = null;
let searchDebounce   = null;

// Bundle state
let bundleItems        = [];      // [{ type, asset, label, weight }]
let bundleAddType      = 'crypto';
let bundleSelectedCoin = null;
let bundleSearchDebounce = null;
let savedBundles     = {};    // { name: [{type,asset,label,weight}] }
let activeBundleName = null;
let editingBundleName = null; // null = creating new

// ── Boot ──────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  spawnStars();
  renderVaultId();
  fetchStatus();
  fetchMoods();
  setInterval(fetchStatus, 30_000);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) {
      closeDropdown();
      closeBundleDropdown();
    }
    // Haptic + flash on any button
    const btn = e.target.closest('button');
    if (btn) {
      if (navigator.vibrate) navigator.vibrate(8);
      btn.classList.remove('btn-clicked');
      void btn.offsetWidth; // reflow to restart animation
      btn.classList.add('btn-clicked');
      btn.addEventListener('animationend', () => btn.classList.remove('btn-clicked'), { once: true });
    }
  });
});

// ── Stars ─────────────────────────────────────────────────────────────────────

function spawnStars() {
  const container = document.getElementById('stars');
  if (!container) return;
  const glyphs = ['✦','✦','✦','✦','✦','✶','✦','✦'];
  for (let i = 0; i < 55; i++) {
    const el = document.createElement('span');
    el.className = 'star';
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
    const res = await apiFetch('/api/status');
    const { state, config } = await res.json();
    renderStatus(state);
    syncFormToConfig(config);
    hideError();
  } catch {
    showError('Cannot reach server. Make sure the backend is running (npm start).');
  }
}

// ── Render status ─────────────────────────────────────────────────────────────

function renderStatus(state) {
  const { color, intensity, alert, label, currentValue, percentChange, lastUpdated, error, detail } = state;

  const lamp = document.getElementById('lampIcon');
  lamp.className = `lamp-icon ${color}`;

  const dot = document.getElementById('statusDot');
  dot.className = `status-dot ${color}${alert ? ' alert-active' : ''}`;

  const badge = document.getElementById('alertBadge');
  if (alert && color !== 'white') {
    badge.style.display = 'block';
    badge.textContent   = '!ALERT';
    badge.className     = `alert-badge${color === 'green' ? ' green-alert' : ''}`;
  } else {
    badge.style.display = 'none';
  }

  document.getElementById('statusLabel').textContent =
    label ? `TRACKING: ${label.toUpperCase()}` : 'TRACKING: —';

  const valEl = document.getElementById('statusValue');
  if (currentValue !== null && currentValue !== undefined) {
    valEl.textContent = `$${formatNumber(currentValue)}`;
    valEl.className   = `status-value${color !== 'white' ? ' ' + color : ''}`;
  } else if (percentChange !== null && percentChange !== undefined) {
    // Bundle mode has no single price
    valEl.textContent = `${percentChange >= 0 ? '+' : ''}${percentChange.toFixed(2)}%`;
    valEl.className   = `status-value${color !== 'white' ? ' ' + color : ''}`;
  } else if (error) {
    valEl.textContent = 'ERR';
    valEl.className   = 'status-value red';
  } else {
    valEl.textContent = 'LOADING...';
    valEl.className   = 'status-value';
  }

  const changeEl = document.getElementById('statusChange');
  if (percentChange !== null && percentChange !== undefined && currentValue !== null && currentValue !== undefined) {
    const sign = percentChange >= 0 ? '▲ +' : '▼ ';
    changeEl.textContent = `${sign}${percentChange.toFixed(2)}% (24H)`;
    changeEl.className   = `status-change ${percentChange >= 0 ? 'positive' : 'negative'}`;
  } else {
    changeEl.textContent = '';
    changeEl.className   = 'status-change';
  }

  document.getElementById('statusDetail').textContent = detail || '';

  if (lastUpdated) {
    document.getElementById('statusTime').textContent =
      new Date(lastUpdated).toLocaleTimeString();
  }

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

// ── EQ Meter ──────────────────────────────────────────────────────────────────

function renderEqMeter(intensity, color) {
  const container = document.getElementById('eqBars');
  if (!container) return;
  const N = 16;
  const active = Math.round(intensity * N);
  let html = '';
  for (let i = 0; i < N; i++) {
    const isActive = i < active;
    const ratio = i / (N - 1);
    let bg = '';
    if (isActive) {
      if (color === 'red') {
        bg = ratio < 0.6 ? '#ff4477' : '#ff0080';
      } else {
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
  } else if (config.mode === 'wallet') {
    const el = document.getElementById('walletInput');
    if (!el.value && config.walletAddress) el.value = config.walletAddress;
  } else if (config.mode === 'bundle') {
    // handled by renderSavedBundles
  }

  if (config.alertThreshold !== undefined) {
    document.getElementById('thresholdSlider').value = config.alertThreshold;
    document.getElementById('thresholdDisplay').textContent = `${config.alertThreshold}%`;
  }

  // Bundle state
  if (config.savedBundles) savedBundles = config.savedBundles;
  if (config.activeBundleName !== undefined) activeBundleName = config.activeBundleName;
  renderSavedBundles();

  // Schedule
  syncScheduleForm(config.schedule);
}

// ── Mode switching ────────────────────────────────────────────────────────────

function switchMode(mode, dom = true) {
  currentMode = mode;
  if (!dom) return;
  ['asset','bundle','wallet'].forEach(m => {
    document.getElementById('tab' + m.charAt(0).toUpperCase() + m.slice(1))
      .classList.toggle('active', m === mode);
    document.getElementById('panel' + m.charAt(0).toUpperCase() + m.slice(1))
      .style.display = m === mode ? '' : 'none';
  });
}

function switchAssetType(type, dom = true) {
  currentAssetType = type;
  if (!dom) return;
  document.getElementById('tabCrypto').classList.toggle('active', type === 'crypto');
  document.getElementById('tabStock').classList.toggle('active', type === 'stock');
  document.getElementById('cryptoInput').style.display = type === 'crypto' ? '' : 'none';
  document.getElementById('stockInput').style.display  = type === 'stock'  ? '' : 'none';
  // Clear the other tab's input
  if (type === 'crypto') {
    document.getElementById('stockTicker').value = '';
  } else {
    document.getElementById('cryptoSearch').value = '';
    selectedCoinId = null;
    closeDropdown();
  }
}

// ── Crypto search (single asset) ─────────────────────────────────────────────

function onCryptoSearch(val) {
  selectedCoinId = null;
  document.getElementById('cryptoHint').textContent = '';
  clearTimeout(searchDebounce);
  if (!val.trim()) { closeDropdown(); return; }
  searchDebounce = setTimeout(() => searchCoins(val, renderDropdown), 350);
}

async function searchCoins(query, callback) {
  try {
    const res   = await apiFetch(`/api/search/crypto?q=${encodeURIComponent(query)}`);
    const coins = await res.json();
    if (!coins.length) { closeDropdown(); return; }
    callback(coins);
  } catch { closeDropdown(); }
}

function renderDropdown(coins) {
  const dd = document.getElementById('cryptoDropdown');
  dd.innerHTML = coins.map(c => `
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

// ── Bundle ────────────────────────────────────────────────────────────────────

function switchBundleAddType(type) {
  bundleAddType = type;
  bundleSelectedCoin = null;
  document.getElementById('tabBundleCrypto').classList.toggle('active', type === 'crypto');
  document.getElementById('tabBundleStock').classList.toggle('active', type === 'stock');
  document.getElementById('bundleAddCrypto').style.display = type === 'crypto' ? '' : 'none';
  document.getElementById('bundleAddStock').style.display  = type === 'stock'  ? '' : 'none';
  // Clear the other tab's input
  if (type === 'crypto') {
    document.getElementById('bundleStockTicker').value = '';
  } else {
    document.getElementById('bundleCryptoSearch').value = '';
    closeBundleDropdown();
  }
}

function onBundleCryptoSearch(val) {
  bundleSelectedCoin = null;
  clearTimeout(bundleSearchDebounce);
  if (!val.trim()) { closeBundleDropdown(); return; }
  bundleSearchDebounce = setTimeout(() => searchCoins(val, renderBundleDropdown), 350);
}

function renderBundleDropdown(coins) {
  const dd = document.getElementById('bundleCryptoDropdown');
  dd.innerHTML = coins.map(c => `
    <div class="dropdown-item" onclick="selectBundleCoin('${c.id}', '${escHtml(c.name)}')">
      ${c.thumb ? `<img src="${c.thumb}" alt="" />` : '<div style="width:18px"></div>'}
      <span class="dropdown-item-name">${escHtml(c.name)}</span>
      <span class="dropdown-item-symbol">${c.symbol}</span>
    </div>
  `).join('');
  dd.classList.add('open');
}

function selectBundleCoin(id, name) {
  bundleSelectedCoin = { id, name };
  document.getElementById('bundleCryptoSearch').value = name;
  closeBundleDropdown();
}

function closeBundleDropdown() {
  document.getElementById('bundleCryptoDropdown').classList.remove('open');
}

function bundleAddItem() {
  const weight = parseInt(document.getElementById('bundleWeightSlider').value) || 50;

  if (bundleAddType === 'crypto') {
    const coinId = bundleSelectedCoin?.id || document.getElementById('bundleCryptoSearch').value.trim().toLowerCase();
    const label  = bundleSelectedCoin?.name || coinId;
    if (!coinId) { showError('Search and select a crypto to add.'); return; }
    bundleItems.push({ type: 'crypto', asset: coinId, label, weight });
    document.getElementById('bundleCryptoSearch').value = '';
    bundleSelectedCoin = null;
  } else {
    const ticker = document.getElementById('bundleStockTicker').value.trim().toUpperCase();
    if (!ticker) { showError('Enter a stock ticker to add.'); return; }
    bundleItems.push({ type: 'stock', asset: ticker, label: ticker, weight });
    document.getElementById('bundleStockTicker').value = '';
  }

  hideError();
  renderBundleList();
}

function bundleRemoveItem(idx) {
  bundleItems.splice(idx, 1);
  renderBundleList();
}

function bundleUpdateWeight(idx, val) {
  bundleItems[idx].weight = parseInt(val);
  document.getElementById(`bw-val-${idx}`).textContent = val;
}

function renderBundleList() {
  const el = document.getElementById('bundleList');
  if (!bundleItems.length) {
    el.innerHTML = '<div class="field-hint" style="margin-bottom:10px">NO ASSETS YET — ADD BELOW</div>';
    return;
  }
  el.innerHTML = bundleItems.map((item, i) => `
    <div class="bundle-item">
      <div class="bundle-item-meta">
        <span class="bundle-item-type">${item.type === 'crypto' ? 'CRYPTO' : 'STOCK'}</span>
        <span class="bundle-item-label">${escHtml(item.label.toUpperCase())}</span>
        <button class="bundle-remove" onclick="bundleRemoveItem(${i})">✕</button>
      </div>
      <div class="bundle-item-weight">
        <span class="slider-tick">WT</span>
        <input type="range" class="slider" min="1" max="100" value="${item.weight}"
          oninput="bundleUpdateWeight(${i}, this.value)" />
        <span class="bundle-weight-val" id="bw-val-${i}">${item.weight}</span>
      </div>
    </div>
  `).join('');
}

// ── Named bundle management ───────────────────────────────────────────────────

function renderSavedBundles() {
  const el = document.getElementById('savedBundlesList');
  if (!el) return;
  const names = Object.keys(savedBundles);
  if (!names.length) {
    el.innerHTML = '<div class="field-hint" style="margin-bottom:10px">NO BUNDLES YET</div>';
    return;
  }
  el.innerHTML = names.map(name => {
    const items = savedBundles[name] || [];
    const isActive = name === activeBundleName && currentMode === 'bundle';
    const preview = items.map(i => i.label?.toUpperCase() || i.asset.toUpperCase()).join(' · ') || '—';
    return `<div class="saved-bundle${isActive ? ' tracking' : ''}">
      <div class="saved-bundle-header">
        <span class="saved-bundle-name">${escHtml(name)}</span>
        <span class="saved-bundle-count">${items.length} ASSET${items.length !== 1 ? 'S' : ''}</span>
        <button class="saved-bundle-track${isActive ? ' active' : ''}" onclick="trackBundle('${escHtml(name)}')">${isActive ? 'TRACKING' : 'TRACK'}</button>
      </div>
      <div class="saved-bundle-assets">${escHtml(preview)}</div>
      <div class="saved-bundle-footer">
        <button class="saved-bundle-action" onclick="editBundle('${escHtml(name)}')">EDIT</button>
        <button class="saved-bundle-action delete" onclick="deleteBundle('${escHtml(name)}')">DELETE</button>
      </div>
    </div>`;
  }).join('');
}

function startNewBundle() {
  editingBundleName = null;
  bundleItems = [];
  document.getElementById('bundleNameInput').value = '';
  renderBundleList();
  document.getElementById('bundleSavedView').style.display = 'none';
  document.getElementById('bundleEditorView').style.display = '';
}

function editBundle(name) {
  editingBundleName = name;
  bundleItems = (savedBundles[name] || []).map(b => ({ ...b }));
  document.getElementById('bundleNameInput').value = name;
  renderBundleList();
  document.getElementById('bundleSavedView').style.display = 'none';
  document.getElementById('bundleEditorView').style.display = '';
}

function cancelBundleEdit() {
  document.getElementById('bundleEditorView').style.display = 'none';
  document.getElementById('bundleSavedView').style.display = '';
}

async function saveNamedBundle() {
  const rawName = document.getElementById('bundleNameInput').value.trim().toUpperCase();
  if (!rawName) { showError('Enter a name for this bundle.'); return; }
  if (!bundleItems.length) { showError('Add at least one asset to the bundle.'); return; }
  hideError();

  // If renaming, remove old name
  if (editingBundleName && editingBundleName !== rawName) {
    delete savedBundles[editingBundleName];
    if (activeBundleName === editingBundleName) activeBundleName = rawName;
  }
  savedBundles[rawName] = bundleItems.map(b => ({ ...b }));

  await postConfig({ savedBundles, activeBundleName });
  editingBundleName = rawName;
  renderSavedBundles();
  cancelBundleEdit();
}

async function trackBundle(name) {
  activeBundleName = name;
  await postConfig({ mode: 'bundle', activeBundleName: name, savedBundles });
  renderSavedBundles();
}

async function deleteBundle(name) {
  delete savedBundles[name];
  if (activeBundleName === name) activeBundleName = null;
  await postConfig({ savedBundles, activeBundleName });
  renderSavedBundles();
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
    const res  = await apiFetch('/api/config', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json();
    if (data.state?.error) showError(data.state.error);
    else { renderStatus(data.state); showToast('SETTINGS APPLIED'); }
  } catch (err) {
    showError('Request failed: ' + err.message);
  }
}

// ── Threshold slider ──────────────────────────────────────────────────────────

function onThresholdChange(val) {
  document.getElementById('thresholdDisplay').textContent = `${parseFloat(val)}%`;
}

// ── Mood log ──────────────────────────────────────────────────────────────────

function toggleMoodOther() {
  const wrap = document.getElementById('moodOtherWrap');
  const isOpen = wrap.style.display !== 'none';
  wrap.style.display = isOpen ? 'none' : '';
  if (!isOpen) setTimeout(() => document.getElementById('moodOtherInput').focus(), 50);
}

function submitMoodOther() {
  const val = document.getElementById('moodOtherInput').value.trim();
  if (!val) return;
  document.getElementById('moodOtherInput').value = '';
  document.getElementById('moodOtherWrap').style.display = 'none';
  logMood(val);
}

async function logMood(mood) {
  try {
    const res  = await apiFetch('/api/mood', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ mood }),
    });
    const data = await res.json();
    renderMoodLog(data.recent);
    showToast('MOOD LOGGED');
    // Flash the selected button
    document.querySelectorAll('.mood-btn').forEach(btn => {
      btn.classList.toggle('mood-active', btn.textContent.trim() === mood);
    });
    setTimeout(() => document.querySelectorAll('.mood-btn').forEach(b => b.classList.remove('mood-active')), 1200);
  } catch (err) {
    showError('Mood log failed: ' + err.message);
  }
}

async function fetchMoods() {
  try {
    const res   = await apiFetch('/api/moods');
    const moods = await res.json();
    renderMoodLog(moods);
  } catch {}
}

function renderMoodLog(moods) {
  const el = document.getElementById('moodLog');
  if (!moods?.length) { el.innerHTML = ''; return; }
  el.innerHTML = moods.map(m => {
    const t = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const d = new Date(m.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
    const change = m.percentChange != null
      ? `${m.percentChange >= 0 ? '+' : ''}${m.percentChange.toFixed(2)}%`
      : '—';
    return `<div class="mood-entry">
      <span class="mood-entry-emoji">${m.mood}</span>
      <span class="mood-entry-meta">${d} ${t}</span>
      <span class="mood-entry-market ${m.lampColor}">${change}</span>
    </div>`;
  }).join('');
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

function showToast(msg) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.remove('toast-hide');
  toast.classList.add('toast-show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('toast-show');
    toast.classList.add('toast-hide');
  }, 2000);
}

function showError(msg) {
  const el = document.getElementById('errorBox');
  el.textContent   = msg;
  el.style.display = 'block';
}

function hideError() {
  document.getElementById('errorBox').style.display = 'none';
}

// ── Vault ─────────────────────────────────────────────────────────────────────

function renderVaultId() {
  const el = document.getElementById('vaultId');
  if (!el) return;
  // Show as two halves for readability
  const [a, b] = [ACCOUNT_ID.slice(0, 18), ACCOUNT_ID.slice(18)];
  el.innerHTML = `<span class="vault-half">${a}</span><span class="vault-half dim">${b}</span>`;
}

async function copyVaultId() {
  await navigator.clipboard.writeText(ACCOUNT_ID);
  const btn = document.getElementById('copyBtn');
  btn.textContent = '[ COPIED! ]';
  setTimeout(() => btn.textContent = '[ COPY_KEY ]', 1500);
}

function toggleRestore() {
  const el = document.getElementById('restoreWrap');
  el.style.display = el.style.display === 'none' ? '' : 'none';
}

function confirmRestore() {
  const val = document.getElementById('restoreInput').value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(val)) {
    showError('Invalid key — paste your full VAULT_ID.');
    return;
  }
  localStorage.setItem('moonlamp_account_id', val);
  location.reload();
}

// ── Schedule ──────────────────────────────────────────────────────────────────

function syncScheduleForm(schedule) {
  if (!schedule) return;
  const checkbox = document.getElementById('scheduleEnabled');
  const wrap     = document.getElementById('scheduleTimeWrap');
  if (checkbox) checkbox.checked = !!schedule.enabled;
  if (wrap) wrap.style.display = schedule.enabled ? '' : 'none';
  if (schedule.startTime) document.getElementById('scheduleStart').value = schedule.startTime;
  if (schedule.endTime)   document.getElementById('scheduleEnd').value   = schedule.endTime;
  updateSchedulePstNow();
}

function onScheduleToggle() {
  const enabled = document.getElementById('scheduleEnabled').checked;
  document.getElementById('scheduleTimeWrap').style.display = enabled ? '' : 'none';
  updateSchedulePstNow();
}

function updateSchedulePstNow() {
  const el = document.getElementById('schedulePstNow');
  if (!el) return;
  const pst = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit',
    second: '2-digit', hour12: true,
  }).format(new Date());
  el.textContent = `CURRENT PST: ${pst}`;
}

async function saveSchedule() {
  hideError();
  const enabled   = document.getElementById('scheduleEnabled').checked;
  const startTime = document.getElementById('scheduleStart').value;
  const endTime   = document.getElementById('scheduleEnd').value;
  await postConfig({ schedule: { enabled, startTime, endTime } });
}
