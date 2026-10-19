/* ─────────────────────────────────────────────
   BuriLabels — AR Plant Finder
   Main application logic
   ───────────────────────────────────────────── */

'use strict';

/* ── Constants ───────────────────────────────── */
const DETECTION_RADIUS_M   = 80;   // meters – show label
const CLOSE_RADIUS_M       = 15;   // meters – "you're right here"
const AR_FOV_DEG           = 70;   // horizontal field of view of AR view
const LABEL_BASE_Y         = 0.42; // vertical position (fraction from top)
const UPDATE_INTERVAL_MS   = 800;  // ms between AR label updates

/* ── State ───────────────────────────────────── */
const state = {
  lat: null, lon: null,
  heading: 0,           // compass heading (degrees, 0=N)
  headingAvailable: false,
  gpsReady: false,
  visiblePlants: [],    // plants within AR_FOV after compass filter
  nearbyPlants: [],     // plants within DETECTION_RADIUS_M
  selectedPlant: null,  // plant shown in drawer
  drawerOpen: false,
  dragging: false,
  dragStartY: 0,
  dragStartTranslate: 0,
  permCamera: false,
  permGPS: false,
};

/* ── DOM refs ─────────────────────────────────── */
const $ = id => document.getElementById(id);
const splash        = $('splash');
const appEl         = $('app');
const cameraFeed    = $('camera-feed');
const arOverlay     = $('ar-overlay');
const compassRose   = $('compass-rose');
const compassHeading= $('compass-heading');
const compassDir    = $('compass-direction');
const gpsDot        = $('gps-dot');
const gpsText       = $('gps-text');
const nearestBadge  = $('nearest-badge');
const nearestText   = $('nearest-text');
const drawer        = $('drawer');
const drawerContent = $('drawer-content');
const peekIcon      = $('peek-icon');
const peekName      = $('peek-name');
const peekSci       = $('peek-sci');
const peekDist      = $('peek-dist');
const noPlantsMsg   = $('no-plants-msg');

// Splash perm status
const camStatus     = $('cam-status');
const gpsStatus     = $('gps-status');
const oriStatus     = $('ori-status');
const startBtn      = $('start-btn');

/* ── Utility: Haversine distance (m) ─────────── */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/* ── Utility: Bearing from user to plant (deg) ─ */
function bearing(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

/* ── Utility: Format distance ─────────────────── */
function fmtDist(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m/1000).toFixed(1)} km`;
}

/* ── Utility: Category → emoji icon ──────────── */
function categoryIcon(plant) {
  const map = {
    trees:   '🌳',
    flowers: '🌸',
    herbs:   '🌿',
    exotics: '🌴',
  };
  return map[plant.category] || '🌱';
}

/* ── Utility: Cardinal direction ─────────────── */
function cardinalDir(deg) {
  const dirs = ['N','NE','E','SE','S','SO','O','NO'];
  return dirs[Math.round(deg / 45) % 8];
}

/* ── Compass ──────────────────────────────────── */
function initCompass() {
  function handleOrientation(e) {
    let h = 0;
    if (e.webkitCompassHeading !== undefined) {
      h = e.webkitCompassHeading; // iOS
    } else if (e.alpha !== null) {
      h = 360 - e.alpha;          // Android
    }
    state.heading = h;
    state.headingAvailable = true;
    compassRose.style.transform = `rotate(${-h}deg)`;
    compassHeading.textContent  = `${Math.round(h)}°`;
    compassDir.textContent      = cardinalDir(h);
    oriStatus.classList.add('ok');
  }

  if (typeof DeviceOrientationEvent !== 'undefined') {
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      // iOS 13+ — permission will be requested on user gesture
      window._iosOriPending = true;
    } else {
      window.addEventListener('deviceorientation', handleOrientation, true);
      oriStatus.classList.add('ok');
    }
  } else {
    oriStatus.classList.add('err');
  }

  window._startCompassWithPermission = function() {
    if (window._iosOriPending) {
      DeviceOrientationEvent.requestPermission().then(res => {
        if (res === 'granted') {
          window.addEventListener('deviceorientation', handleOrientation, true);
          oriStatus.classList.add('ok');
        } else {
          oriStatus.classList.add('err');
        }
      }).catch(() => oriStatus.classList.add('err'));
    }
  };
}

/* ── GPS ──────────────────────────────────────── */
function initGPS() {
  if (!navigator.geolocation) {
    gpsText.textContent = 'Non disponibile';
    gpsDot.classList.add('error');
    gpsStatus.classList.add('err');
    return;
  }

  gpsText.textContent = 'Ricerca…';
  gpsDot.classList.add('searching');

  navigator.geolocation.watchPosition(
    pos => {
      state.lat = pos.coords.latitude;
      state.lon = pos.coords.longitude;
      state.gpsReady = true;
      gpsDot.classList.remove('searching');
      gpsDot.classList.remove('error');
      gpsText.textContent = `${state.lat.toFixed(5)}, ${state.lon.toFixed(5)}`;
      gpsStatus.classList.add('ok');
    },
    err => {
      gpsDot.classList.add('error');
      gpsText.textContent = 'Errore GPS';
      gpsStatus.classList.add('err');
      console.warn('GPS error', err);
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
  );
}

/* ── Camera ───────────────────────────────────── */
async function initCamera() {
  try {
    // Prefer rear camera for AR
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    cameraFeed.srcObject = stream;
    cameraFeed.classList.add('rear');
    cameraFeed.play().catch(() => {});
    state.permCamera = true;
    camStatus.classList.add('ok');
    return true;
  } catch (err) {
    console.error('Camera error', err);
    camStatus.classList.add('err');
    return false;
  }
}

/* ── AR Label rendering ───────────────────────── */
let labelUpdateTimer = null;

function updateARLabels() {
  if (!state.gpsReady) return;

  // Compute nearby plants with distance and bearing
  const enriched = PLANTS_DATABASE.map(p => {
    const dist = haversineDistance(state.lat, state.lon, p.coordinates[0], p.coordinates[1]);
    const bear = bearing(state.lat, state.lon, p.coordinates[0], p.coordinates[1]);
    return { ...p, _dist: dist, _bearing: bear };
  }).filter(p => p._dist <= DETECTION_RADIUS_M)
    .sort((a, b) => a._dist - b._dist);

  state.nearbyPlants = enriched;

  // Compute relative horizontal angle for AR positioning
  const inView = [];
  if (state.headingAvailable) {
    for (const p of enriched) {
      let relAngle = p._bearing - state.heading;
      // Normalize to [-180, 180]
      while (relAngle > 180) relAngle -= 360;
      while (relAngle < -180) relAngle += 360;
      p._relAngle = relAngle;
      if (Math.abs(relAngle) <= AR_FOV_DEG / 2) {
        inView.push(p);
      }
    }
  } else {
    // No compass — show all nearby in a spread layout
    enriched.forEach((p, i) => {
      p._relAngle = (i - (enriched.length-1)/2) * 25; // spread
      inView.push(p);
    });
  }

  state.visiblePlants = inView;
  renderLabels(inView, enriched);
  updateDrawerPeek(enriched[0] || null);
  updateNearestBadge(enriched[0] || null);
}

function renderLabels(inView, allNearby) {
  // Remove existing labels
  document.querySelectorAll('.plant-label').forEach(el => el.remove());

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  inView.forEach((p, i) => {
    const label = document.createElement('div');
    label.className = 'plant-label' + (i === 0 && p._dist < CLOSE_RADIUS_M * 3 ? ' closest' : '');
    label.dataset.id = p.id;

    // Horizontal position based on relative angle
    const halfFOV = AR_FOV_DEG / 2;
    const xFraction = (p._relAngle + halfFOV) / AR_FOV_DEG; // 0..1
    const x = xFraction * vw;

    // Vertical: closer plants are lower on screen
    const distFraction = Math.min(p._dist / DETECTION_RADIUS_M, 1);
    const y = vh * 0.25 + distFraction * (vh * 0.30);

    // Pin height
    const pinH = Math.max(30, 80 - distFraction * 50);

    label.style.cssText = `left:${x}px; top:${y}px; transform:translateX(-50%);`;
    label.innerHTML = `
      <div class="label-bubble">
        <div class="plant-icon">${categoryIcon(p)}</div>
        <div class="plant-name">${p.name}</div>
        <div class="plant-sci">${p.scientificName}</div>
        <div class="plant-dist">📍 ${fmtDist(p._dist)}</div>
      </div>
      <div class="label-pin" style="height:${pinH}px"></div>
    `;

    label.addEventListener('click', () => openDrawer(p));
    arOverlay.appendChild(label);
  });

  // Show/hide "no plants" message
  if (state.gpsReady && allNearby.length === 0) {
    noPlantsMsg.classList.add('visible');
  } else {
    noPlantsMsg.classList.remove('visible');
  }
}

/* ── Drawer ──────────────────────────────────── */
function updateDrawerPeek(plant) {
  if (!plant) return;
  if (state.selectedPlant?.id !== plant.id) {
    // Auto-select closest
    if (!state.drawerOpen) openDrawerPeek(plant);
  }
}

function openDrawerPeek(plant) {
  state.selectedPlant = plant;
  peekIcon.textContent = categoryIcon(plant);
  peekName.textContent = plant.name;
  peekSci.textContent  = plant.scientificName;
  peekDist.textContent = `📍 ${fmtDist(plant._dist)}`;
}

function openDrawer(plant) {
  state.selectedPlant = plant;
  openDrawerPeek(plant);
  populateDrawerContent(plant);

  drawer.classList.add('open');
  drawer.classList.remove('collapsed');
  state.drawerOpen = true;
}

function closeDrawer() {
  drawer.classList.remove('open');
  state.drawerOpen = false;
}

function populateDrawerContent(plant) {
  const img = plant.image
    ? `<img src="images/${plant.image}" alt="${plant.name}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
    : '';
  const placeholder = `<div class="img-placeholder">${categoryIcon(plant)}</div>`;

  const rarityLabel = {
    common: 'Comune', rare: 'Raro', legendary: 'Leggendario'
  }[plant.rarity] || plant.rarity;

  $('drawer-content').innerHTML = `
    <div class="drawer-inner">
      <div id="plant-image-container">
        ${img}
        <div class="img-placeholder" style="display:${plant.image?'none':'flex'}">${categoryIcon(plant)}</div>
        <span class="image-badge rarity-${plant.rarity}">${rarityLabel}</span>
      </div>

      <div class="plant-title-section">
        <h2>${plant.name}</h2>
        <div class="sci-name">${plant.scientificName}</div>
        <div class="family-tag">🔬 ${plant.family}</div>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">☀️</div>
          <div class="stat-label">Luce</div>
          <div class="stat-value">${plant.sunlight}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">💧</div>
          <div class="stat-label">Acqua</div>
          <div class="stat-value">${plant.water}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">📏</div>
          <div class="stat-label">Altezza</div>
          <div class="stat-value">${plant.height}</div>
        </div>
      </div>

      <div class="section-title">Descrizione</div>
      <p class="plant-description">${plant.description}</p>

      <div class="section-title">Lo sapevi?</div>
      <div class="fun-fact-card">
        <span class="ff-icon">💡</span>
        <span class="ff-text">${plant.funFact}</span>
      </div>

      <div class="info-row">
        <span class="info-icon">🌍</span>
        <span class="info-label">Origini</span>
        <span class="info-value">${plant.nativeTo}</span>
      </div>
      ${plant._dist != null ? `
      <div class="info-row">
        <span class="info-icon">📍</span>
        <span class="info-label">Distanza</span>
        <span class="info-value">${fmtDist(plant._dist)}</span>
      </div>` : ''}
    </div>
  `;
}

/* ── Nearest Badge ────────────────────────────── */
function updateNearestBadge(plant) {
  if (!plant) {
    nearestBadge.classList.remove('visible');
    return;
  }
  if (plant._dist <= CLOSE_RADIUS_M) {
    nearestBadge.classList.add('visible');
    $('nearest-text').textContent = `🌿 Sei vicino a: ${plant.name} (${fmtDist(plant._dist)})`;
  } else {
    nearestBadge.classList.remove('visible');
  }
}

/* ── Drawer Drag ─────────────────────────────── */
function initDrawerDrag() {
  const handle = $('drawer-handle');
  const peek   = $('drawer-peek');

  // Tap on peek → toggle drawer
  peek.addEventListener('click', () => {
    if (!state.selectedPlant) return;
    if (state.drawerOpen) {
      closeDrawer();
    } else {
      openDrawer(state.selectedPlant);
    }
  });

  // Drag to open/close
  let startY = 0, startOpen = false, moved = false;

  function onStart(e) {
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    startY    = clientY;
    startOpen = state.drawerOpen;
    moved     = false;
    state.dragging = true;
    drawer.style.transition = 'none';
  }

  function onMove(e) {
    if (!state.dragging) return;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dy = clientY - startY;
    if (Math.abs(dy) > 8) moved = true;

    if (moved) {
      e.preventDefault();
      // Rubber-band translation
      const clamped = Math.max(-20, Math.min(dy, startOpen ? 300 : 20));
      drawer.style.transform = startOpen
        ? `translateY(${Math.max(0, clamped)}px)`
        : `translateY(${Math.min(0, clamped)}px)`;
    }
  }

  function onEnd(e) {
    if (!state.dragging) return;
    state.dragging = false;
    drawer.style.transition = '';
    drawer.style.transform  = '';

    if (!moved) return; // treat as tap

    const clientY = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
    const dy = clientY - startY;

    if (startOpen && dy > 80) {
      closeDrawer();
    } else if (!startOpen && dy < -60) {
      if (state.selectedPlant) openDrawer(state.selectedPlant);
    }
  }

  handle.addEventListener('touchstart', onStart, { passive: true });
  handle.addEventListener('touchmove',  onMove,  { passive: false });
  handle.addEventListener('touchend',   onEnd,   { passive: true });
  handle.addEventListener('mousedown',  onStart);
  window.addEventListener('mousemove',  onMove);
  window.addEventListener('mouseup',    onEnd);
}

/* ── Splash / Permission flow ─────────────────── */
async function handleStart() {
  startBtn.disabled = true;
  startBtn.textContent = 'Avvio…';

  // iOS orientation permission (must be on click)
  if (window._startCompassWithPermission) {
    window._startCompassWithPermission();
  }

  const camOk = await initCamera();
  if (!camOk) {
    startBtn.disabled = false;
    startBtn.textContent = 'Riprova';
    return;
  }

  // Transition to app
  splash.style.opacity = '0';
  splash.style.transition = 'opacity 0.6s ease';
  setTimeout(() => {
    splash.style.display = 'none';
    appEl.classList.add('visible');
  }, 600);

  // Start AR loop
  labelUpdateTimer = setInterval(updateARLabels, UPDATE_INTERVAL_MS);
  updateARLabels(); // immediate first run
}

/* ── Init ─────────────────────────────────────── */
function init() {
  initCompass();
  initGPS();
  initDrawerDrag();

  startBtn.addEventListener('click', handleStart);

  // Keyboard: Escape closes drawer
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.drawerOpen) closeDrawer();
  });

  // Update distances in peek while drawer open
  setInterval(() => {
    if (state.selectedPlant && state.gpsReady) {
      const d = haversineDistance(
        state.lat, state.lon,
        state.selectedPlant.coordinates[0],
        state.selectedPlant.coordinates[1]
      );
      state.selectedPlant._dist = d;
      peekDist.textContent = `📍 ${fmtDist(d)}`;
    }
  }, 2000);
}

document.addEventListener('DOMContentLoaded', init);
