// ───── STATE ─────
const state = {
  riding: false,
  rideStartedAt: null,
  speed: 0,
  maxSpeed: 0,
  avgSpeed: 0,
  distance: 0,
  totalTime: 0,
  speedLimit: null,
  lastPos: null,
  lastTime: null,
  speedHistory: [],
  gpsReady: false,
  wakeLock: null,
  speedAlertOn: true,
  wakeLockOn: true,
  maxDisplaySpeed: 60,
  accentColor: '#00c3ff',
  watchId: null,
  mapReady: false,
};

// Leaflet map
let map = null;
let userMarker = null;
let pathLine = null;
let pathCoords = [];

// Speed limit fetch debounce
let limitFetchTimeout = null;
let lastLimitFetchPos = null;

// ───── INIT ─────
document.addEventListener('DOMContentLoaded', () => {
  updateClock();
  setInterval(updateClock, 1000);
  generateTicks();
  initMap();

  // Load prefs
  const saved = localStorage.getItem('velocom_prefs');
  if (saved) {
    try {
      const prefs = JSON.parse(saved);
      if (prefs.color) setColor(prefs.color);
      if (prefs.maxSpeed) {
        state.maxDisplaySpeed = prefs.maxSpeed;
        document.getElementById('max-speed-input').value = prefs.maxSpeed;
      }
      if (typeof prefs.speedAlert === 'boolean') {
        state.speedAlertOn = prefs.speedAlert;
        const el = document.getElementById('speed-alert-toggle');
        if (!prefs.speedAlert) el.classList.remove('on');
      }
    } catch(e) {}
  }

  initGPS();
});

// ───── CLOCK ─────
function updateClock() {
  const now = new Date();
  document.getElementById('time-display').textContent =
    now.getHours().toString().padStart(2,'0') + ':' +
    now.getMinutes().toString().padStart(2,'0');
}

// ───── MAP ─────
function initMap() {
  map = L.map('map', {
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    tap: false,
  }).setView([48.8566, 2.3522], 15);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
  }).addTo(map);

  // Custom user marker
  const markerIcon = L.divIcon({
    html: `<div style="
      width:14px;height:14px;
      background:var(--accent,#00c3ff);
      border:2px solid white;
      border-radius:50%;
      box-shadow:0 0 10px var(--accent,#00c3ff);
    "></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
    className: '',
  });

  userMarker = L.marker([48.8566, 2.3522], { icon: markerIcon }).addTo(map);

  pathLine = L.polyline([], {
    color: state.accentColor,
    weight: 3,
    opacity: 0.7,
  }).addTo(map);

  state.mapReady = true;
}

function updateMap(lat, lon) {
  if (!state.mapReady) return;
  const latlng = [lat, lon];
  userMarker.setLatLng(latlng);
  map.setView(latlng, 15);
  if (state.riding) {
    pathCoords.push(latlng);
    pathLine.setLatLngs(pathCoords);
  }
}

// ───── GPS ─────
function initGPS() {
  document.getElementById('no-gps-screen').classList.add('hidden');

  if (!navigator.geolocation) {
    showNoGPS('Ton navigateur ne supporte pas la géolocalisation.');
    return;
  }

  document.getElementById('gps-dot').className = 'searching';
  document.getElementById('gps-label').textContent = 'Recherche GPS...';

  state.watchId = navigator.geolocation.watchPosition(
    onGPSUpdate,
    onGPSError,
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000,
    }
  );
}

function onGPSUpdate(pos) {
  const { latitude, longitude, speed, accuracy } = pos.coords;
  const now = Date.now();

  // GPS acquired
  if (!state.gpsReady) {
    state.gpsReady = true;
    document.getElementById('no-gps-screen').classList.add('hidden');
    document.getElementById('gps-dot').className = 'active';
    document.getElementById('gps-label').textContent =
      'GPS ±' + Math.round(accuracy) + 'm';
  }

  // Update map
  updateMap(latitude, longitude);

  // Speed from GPS (m/s → km/h)
  let spd = 0;
  if (speed !== null && speed !== undefined && speed >= 0) {
    spd = speed * 3.6;
  } else if (state.lastPos && state.lastTime) {
    // Fallback: calculate from distance/time
    const d = haversine(state.lastPos.lat, state.lastPos.lon, latitude, longitude);
    const dt = (now - state.lastTime) / 1000;
    if (dt > 0.1) spd = (d / dt) * 3.6;
  }

  // Clamp & smooth
  spd = Math.max(0, spd);
  if (spd > 120) spd = 0; // GPS glitch filter
  state.speed = smoothSpeed(spd);

  // Trip stats (only when riding)
  if (state.riding && state.lastPos) {
    const d = haversine(state.lastPos.lat, state.lastPos.lon, latitude, longitude);
    state.distance += d / 1000;

    const dt = (now - state.lastTime) / 1000;
    state.totalTime += dt;

    state.speedHistory.push(state.speed);
    state.avgSpeed = state.speedHistory.reduce((a,b) => a+b, 0) / state.speedHistory.length;

    if (state.speed > state.maxSpeed) state.maxSpeed = state.speed;
  }

  state.lastPos = { lat: latitude, lon: longitude };
  state.lastTime = now;

  // Fetch speed limit (debounced, only every ~100m or on position change)
  const shouldFetch = !lastLimitFetchPos ||
    haversine(lastLimitFetchPos.lat, lastLimitFetchPos.lon, latitude, longitude) > 80;

  if (shouldFetch) {
    lastLimitFetchPos = { lat: latitude, lon: longitude };
    clearTimeout(limitFetchTimeout);
    limitFetchTimeout = setTimeout(() => fetchSpeedLimit(latitude, longitude), 500);
  }

  renderUI();
}

function onGPSError(err) {
  document.getElementById('gps-dot').className = '';
  document.getElementById('gps-dot').style.background = '#ff2244';

  let msg = 'Erreur GPS.';
  if (err.code === 1) msg = 'Accès GPS refusé. Autorise la localisation dans les paramètres.';
  if (err.code === 2) msg = 'Position GPS indisponible.';
  if (err.code === 3) msg = 'Timeout GPS — réessaie.';

  document.getElementById('gps-label').textContent = msg.split('.')[0];
  showNoGPS(msg);
}

function showNoGPS(msg) {
  document.querySelector('.no-gps-msg').textContent = msg;
  document.getElementById('no-gps-screen').classList.remove('hidden');
}

// ───── SPEED LIMIT (OpenStreetMap/Overpass) ─────
async function fetchSpeedLimit(lat, lon) {
  try {
    const r = 30;
    const query = `[out:json][timeout:5];
      way(around:${r},${lat},${lon})[highway][maxspeed];
      out tags 1;`;
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();

    if (data.elements && data.elements.length > 0) {
      const el = data.elements[0];
      const ms = el.tags?.maxspeed;
      if (ms) {
        const parsed = parseInt(ms);
        if (!isNaN(parsed)) {
          state.speedLimit = parsed;
          document.getElementById('speed-limit-value').textContent = parsed;
          renderSpeedLimitWarning();
          return;
        }
      }
    }
    // No data found
    state.speedLimit = null;
    document.getElementById('speed-limit-value').textContent = '--';
  } catch(e) {
    // Fail silently
  }
}

function renderSpeedLimitWarning() {
  if (!state.speedAlertOn || state.speedLimit === null) {
    document.getElementById('over-limit-badge').classList.remove('visible');
    return;
  }
  if (state.speed > state.speedLimit + 2) {
    document.getElementById('over-limit-badge').classList.add('visible');
    document.getElementById('speed-limit-sign').style.borderColor = 'var(--danger)';
  } else {
    document.getElementById('over-limit-badge').classList.remove('visible');
    document.getElementById('speed-limit-sign').style.borderColor = '#cc0000';
  }
}

// ───── SPEEDOMETER ARC ─────
const ARC_LENGTH = 440; // total arc length in SVG units

function generateTicks() {
  const svg = document.getElementById('tick-marks');
  const cx = 170, cy = 185, r = 140;
  const startAngle = 180; // degrees
  const endAngle = 360;
  const steps = 12;

  for (let i = 0; i <= steps; i++) {
    const angle = startAngle + (endAngle - startAngle) * (i / steps);
    const rad = (angle * Math.PI) / 180;
    const major = i % 3 === 0;
    const len = major ? 14 : 8;
    const x1 = cx + (r - 5) * Math.cos(rad);
    const y1 = cy + (r - 5) * Math.sin(rad);
    const x2 = cx + (r - 5 - len) * Math.cos(rad);
    const y2 = cy + (r - 5 - len) * Math.sin(rad);

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('stroke', major ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)');
    line.setAttribute('stroke-width', major ? 2 : 1);
    line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(line);

    // Labels for major ticks
    if (major) {
      const speedVal = Math.round((i / steps) * state.maxDisplaySpeed);
      const tx = cx + (r - 30) * Math.cos(rad);
      const ty = cy + (r - 30) * Math.sin(rad);
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', tx); text.setAttribute('y', ty);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'middle');
      text.setAttribute('fill', 'rgba(255,255,255,0.25)');
      text.setAttribute('font-size', '10');
      text.setAttribute('font-family', 'Orbitron, monospace');
      text.textContent = speedVal;
      svg.appendChild(text);
    }
  }
}

function updateArc(speed) {
  const ratio = Math.min(speed / state.maxDisplaySpeed, 1);
  const offset = ARC_LENGTH - ratio * ARC_LENGTH;

  const arc = document.getElementById('arc-progress');
  const glow = document.getElementById('arc-glow');
  arc.setAttribute('stroke-dashoffset', offset);
  glow.setAttribute('stroke-dashoffset', offset);

  // Color shift: blue → orange → red
  let color;
  if (ratio < 0.7) {
    color = state.accentColor;
  } else if (ratio < 0.9) {
    color = '#ff6b00';
  } else {
    color = '#ff2244';
  }
  arc.setAttribute('stroke', color);
  glow.setAttribute('stroke', color);

  // Speed value color
  document.getElementById('speed-value').style.textShadow =
    `0 0 30px ${color}, 0 0 60px ${hexToRgba(color, 0.4)}`;
}

// ───── RENDER ─────
function renderUI() {
  // Speed
  const displaySpeed = Math.round(state.speed);
  document.getElementById('speed-value').textContent = displaySpeed;
  updateArc(state.speed);

  // Stats
  document.getElementById('stat-distance').innerHTML =
    state.distance.toFixed(2) + '<span> km</span>';
  document.getElementById('stat-avg').innerHTML =
    (state.riding ? state.avgSpeed : 0).toFixed(1) + '<span> km/h</span>';
  document.getElementById('stat-max').innerHTML =
    state.maxSpeed.toFixed(1) + '<span> km/h</span>';

  renderSpeedLimitWarning();
}

// ───── RIDE CONTROL ─────
function toggleRide() {
  state.riding = !state.riding;
  const btn = document.getElementById('ride-btn');

  if (state.riding) {
    if (!state.rideStartedAt) state.rideStartedAt = new Date().toISOString();
    btn.textContent = 'Pause';
    btn.style.borderColor = 'var(--warn)';
    btn.style.color = 'var(--warn)';
    btn.style.background = 'rgba(255,107,0,0.05)';
    if (!pathCoords.length) { pathCoords = []; pathLine.setLatLngs([]); }
    requestWakeLock();
  } else {
    btn.textContent = 'Reprendre';
    btn.style.borderColor = '';
    btn.style.color = '';
    btn.style.background = '';
    // Auto-save on pause if meaningful ride
    if (state.distance > 0.01) saveRide();
  }
}

function saveRide() {
  const rideData = {
    startedAt: state.rideStartedAt || new Date().toISOString(),
    distance: parseFloat(state.distance.toFixed(3)),
    avgSpeed: parseFloat(state.avgSpeed.toFixed(1)),
    maxSpeed: parseFloat(state.maxSpeed.toFixed(1)),
    duration: Math.round(state.totalTime),
  };
  if (typeof window.saveRideToFirestore === 'function') {
    window.saveRideToFirestore(rideData);
  }
}

function resetTrip() {
  state.distance = 0;
  state.avgSpeed = 0;
  state.maxSpeed = 0;
  state.totalTime = 0;
  state.speedHistory = [];
  state.riding = false;
  state.rideStartedAt = null;
  pathCoords = [];
  if (pathLine) pathLine.setLatLngs([]);

  const btn = document.getElementById('ride-btn');
  btn.textContent = 'Démarrer';
  btn.style.borderColor = '';
  btn.style.color = '';
  btn.style.background = '';

  renderUI();
}

// ───── WAKE LOCK ─────
async function requestWakeLock() {
  if (!state.wakeLockOn || !('wakeLock' in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
  } catch(e) {}
}

function toggleWakeLock(el) {
  el.classList.toggle('on');
  state.wakeLockOn = el.classList.contains('on');
  if (!state.wakeLockOn && state.wakeLock) {
    state.wakeLock.release();
    state.wakeLock = null;
  }
  savePrefs();
}

// ───── SPEED ALERT TOGGLE ─────
function toggleSpeedAlert(el) {
  el.classList.toggle('on');
  state.speedAlertOn = el.classList.contains('on');
  savePrefs();
}

// ───── COLOR ─────
function setColor(hex) {
  state.accentColor = hex;
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);

  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.4)`);
  document.documentElement.style.setProperty('--accent-dim', `rgba(${r},${g},${b},0.15)`);

  document.getElementById('arc-progress').setAttribute('stroke', hex);
  document.getElementById('arc-glow').setAttribute('stroke', hex);
  if (pathLine) pathLine.setStyle({ color: hex });

  // Update marker
  if (userMarker) {
    const icon = L.divIcon({
      html: `<div style="
        width:14px;height:14px;
        background:${hex};
        border:2px solid white;
        border-radius:50%;
        box-shadow:0 0 10px ${hex};
      "></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
      className: '',
    });
    userMarker.setIcon(icon);
  }

  savePrefs();
}

function setPresetColor(el) {
  document.querySelectorAll('.color-preset').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  const color = el.dataset.color;
  document.getElementById('custom-color').value = color;
  setColor(color);
}

function setCustomColor(hex) {
  document.querySelectorAll('.color-preset').forEach(p => p.classList.remove('active'));
  setColor(hex);
}

// ───── MAX SPEED ─────
function updateMaxSpeed(val) {
  const v = parseInt(val);
  if (isNaN(v) || v < 10) return;
  state.maxDisplaySpeed = v;
  // Redraw ticks
  document.getElementById('tick-marks').innerHTML = '';
  generateTicks();
  savePrefs();
}

// ───── MENU ─────
function openMenu() {
  document.getElementById('menu-overlay').classList.add('open');
  document.getElementById('map-panel').style.visibility = 'hidden';
}
function closeMenu() {
  document.getElementById('menu-overlay').classList.remove('open');
  document.getElementById('map-panel').style.visibility = 'visible';
}
function closeMenuIfOutside(e) {
  if (e.target === document.getElementById('menu-overlay')) closeMenu();
}

// ───── PREFS ─────
function savePrefs() {
  localStorage.setItem('velocom_prefs', JSON.stringify({
    color: state.accentColor,
    maxSpeed: state.maxDisplaySpeed,
    speedAlert: state.speedAlertOn,
  }));
}

// ───── UTILS ─────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

let speedBuffer = [];
function smoothSpeed(raw) {
  speedBuffer.push(raw);
  if (speedBuffer.length > 5) speedBuffer.shift();
  return speedBuffer.reduce((a,b) => a+b, 0) / speedBuffer.length;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
