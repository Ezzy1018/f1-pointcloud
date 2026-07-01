import * as THREE from 'three';
import { loadF1Points } from './f1-points.js';

let scene, camera, renderer;
let parts = [];
let materials = [];
let modelCenter = new THREE.Vector3(0, 0, 0);
let modelSize = new THREE.Vector3(1, 1, 1);

// Orbit state
const st = { theta: 2.35, phi: 1.12, radius: 15, tgt: new THREE.Vector3(0, 0, 0) };
const cur = { theta: st.theta, phi: st.phi, radius: st.radius };
let autoRotate = true;
let dragging = false;
let lastX = 0, lastY = 0, downX = 0, downY = 0, downT = 0, moved = false;

let colorMode = 'livery'; // 'livery' or 'segmented'
let densityFraction = 1.0;
let loadedData = null;
let modelLoaded = false;
let loaderStart = performance.now();
const LOADER_DURATION = 1500; // ms
let loaderComplete = false;

// FPS performance probe parameters
let frameCount = 0;
let startTime = 0;
let hasProbed = false;
let totalPointsTarget = 1400000;
let currentPointSize = 0.04;

// Canvas texture for glowing particles
function createCircleTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
  grad.addColorStop(0.2, 'rgba(255, 255, 255, 0.85)');
  grad.addColorStop(0.5, 'rgba(255, 255, 255, 0.25)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
const circleTexture = createCircleTexture();

// Initialize scene
const canvas = document.getElementById('scene');
renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const PR = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(PR);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x05070d, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;

scene = new THREE.Scene();
camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 300);

// Load points
async function initApp() {
  try {
    const data = await loadF1Points('/assets/models/f1.glb', { totalPoints: totalPointsTarget });
    modelCenter.set(data.center[0], data.center[1], data.center[2]);
    modelSize.set(data.size[0], data.size[1], data.size[2]);
    loadedData = data;
    modelLoaded = true;
  } catch (err) {
    console.error("Failed to load F1 Model:", err);
    const brand = document.querySelector('.loader__brand');
    if (brand) brand.innerHTML = "F1<span>ERROR</span>";
    const pct = document.querySelector('.loader__pct');
    if (pct) pct.textContent = "Err";
  }
}

function buildModel(data) {
  // Clear existing parts from scene
  parts.forEach(p => scene.remove(p.points));
  parts = [];
  materials = [];
  
  // Re-align camera target
  st.tgt.copy(modelCenter);
  st.radius = Math.max(modelSize.x, modelSize.y, modelSize.z) * 1.6;
  st.phi = 1.12;
  st.theta = 2.35;
  
  data.parts.forEach(pData => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pData.positions, 3));
    
    const activeColors = colorMode === 'livery' ? pData.liveryColors : pData.segColors;
    geo.setAttribute('color', new THREE.BufferAttribute(activeColors, 3));
    geo.computeBoundingSphere();
    
    const mat = new THREE.PointsMaterial({
      size: currentPointSize,
      sizeAttenuation: true,
      vertexColors: true,
      map: circleTexture,
      transparent: true,
      opacity: 0.28 + 0.72 * densityFraction,
      depthWrite: true,
      depthTest: true,
      alphaTest: 0.05,
      blending: THREE.NormalBlending
    });
    
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    scene.add(points);
    
    parts.push({
      def: {
        name: pData.name,
        color: pData.segColor,
        dir: pData.dir
      },
      points,
      mat,
      liveryColors: pData.liveryColors,
      segColors: pData.segColors,
      target: 0,
      cur: 0,
      hoverT: 0,
      hoverCur: 0
    });
    materials.push(mat);
  });
  
  buildLegend();
  updateDashboard(null);
}

function initGround(radiusLimit) {
  const N = 36000;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const rad = radiusLimit * 2.1;
  for (let i = 0; i < N; i++) {
    const ang = Math.random() * Math.PI * 2;
    const r = Math.pow(Math.random(), 0.6) * rad;
    pos[i*3] = Math.cos(ang) * r + modelCenter.x;
    pos[i*3+1] = modelCenter.y - modelSize.y * 0.46; // align floor with tire base
    pos[i*3+2] = Math.sin(ang) * r + modelCenter.z;
    
    const ring = 0.5 + 0.5 * Math.sin(r * (18.0 / rad));
    const near = Math.max(0, 1.0 - r / rad);
    const b = (0.08 + 0.14 * ring) * (0.3 + 0.7 * near);
    
    col[i*3] = b * 0.55;
    col[i*3+1] = b * 0.8;
    col[i*3+2] = b * 1.0;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  
  const m = new THREE.PointsMaterial({
    size: 0.045,
    sizeAttenuation: true,
    vertexColors: true,
    map: circleTexture,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  scene.add(p);
}

// Resampling optimization for mobile fallback
async function rebuildPointCloud(newCount, newSize) {
  totalPointsTarget = newCount;
  currentPointSize = newSize;
  
  const loader = document.getElementById('loader');
  const text = document.getElementById('loadtext');
  if (loader) {
    loader.classList.remove('gone');
    text.textContent = "Optimizing engine for your device...";
  }
  
  try {
    const data = await loadF1Points('/assets/models/f1.glb', { totalPoints: totalPointsTarget });
    buildModel(data);
    setTimeout(() => {
      if (loader) loader.classList.add('gone');
    }, 450);
  } catch (err) {
    console.error("Failed to rebuild:", err);
  }
}

// Custom Orbit interaction
canvas.addEventListener('pointerdown', e => {
  dragging = true; moved = false; lastX = downX = e.clientX; lastY = downY = e.clientY; downT = performance.now();
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', e => {
  if (dragging) {
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 6) moved = true;
    st.theta -= dx * 0.005; st.phi -= dy * 0.005;
    st.phi = Math.max(0.15, Math.min(1.48, st.phi));
  } else {
    hoverPick(e.clientX, e.clientY);
  }
});

function endDrag(e) {
  if (!dragging) return; dragging = false;
  const quick = performance.now() - downT < 400;
  if (!moved && quick) clickPick(e.clientX, e.clientY);
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', () => { dragging = false; });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  st.radius = Math.max(modelSize.z * 0.6, Math.min(modelSize.z * 3.5, st.radius + e.deltaY * 0.012));
}, { passive: false });

// Raycasting
const ray = new THREE.Raycaster();
ray.params.Points.threshold = 0.15;
const ndc = new THREE.Vector2();

function pick(cx, cy) {
  ndc.x = (cx / window.innerWidth) * 2 - 1;
  ndc.y = -(cy / window.innerHeight) * 2 + 1;
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(parts.map(p => p.points), false);
  if (!hits.length) return null;
  return parts.find(p => p.points === hits[0].object) || null;
}

function clickPick(cx, cy) {
  const part = pick(cx, cy);
  if (part) {
    part.target = part.target > 0.5 ? 0 : 1;
    syncChips();
    
    const activeParts = parts.filter(pt => pt.target > 0.5);
    if (activeParts.length === 1) {
      updateDashboard(activeParts[0]);
    } else if (activeParts.length === parts.length) {
      updateDashboard('all');
    } else if (activeParts.length > 0) {
      updateDashboard(part.target > 0.5 ? part : activeParts[activeParts.length - 1]);
    } else {
      updateDashboard(null);
    }
  } else {
    parts.forEach(p => p.target = 0);
    syncChips();
    updateDashboard(null);
  }
}

const hoverEl = document.getElementById('hover');
const hN = hoverEl.querySelector('.n'), hS = hoverEl.querySelector('.s');
function hoverPick(cx, cy) {
  const part = pick(cx, cy);
  parts.forEach(p => p.hoverT = (p === part) ? 1 : 0);
  if (part) {
    canvas.style.cursor = 'pointer';
    hN.innerHTML = part.def.name; hS.innerHTML = 'F1 Dynamic Component';
    hoverEl.style.left = cx + 'px'; hoverEl.style.top = cy + 'px'; hoverEl.style.opacity = '1';
  } else {
    canvas.style.cursor = dragging ? 'grabbing' : 'grab'; hoverEl.style.opacity = '0';
  }
}

// Legend
function buildLegend() {
  const legend = document.getElementById('legend');
  legend.innerHTML = '';
  parts.forEach((p, i) => {
    const chip = document.createElement('div');
    chip.className = 'chip'; chip.dataset.i = i;
    const c = p.def.color;
    const hex = 'rgb(' + (c[0]*255|0) + ',' + (c[1]*255|0) + ',' + (c[2]*255|0) + ')';
    chip.innerHTML = '<span class="dot" style="background:' + hex + '; color:' + hex + '"></span>' + p.def.name;
    
    chip.addEventListener('click', () => {
      p.target = p.target > 0.5 ? 0 : 1;
      syncChips();
      const activeParts = parts.filter(pt => pt.target > 0.5);
      if (activeParts.length === 1) {
        updateDashboard(activeParts[0]);
      } else if (activeParts.length === parts.length) {
        updateDashboard('all');
      } else if (activeParts.length > 0) {
        updateDashboard(p.target > 0.5 ? p : activeParts[activeParts.length - 1]);
      } else {
        updateDashboard(null);
      }
    });
    
    chip.addEventListener('mouseenter', () => { p.hoverT = 1; });
    chip.addEventListener('mouseleave', () => { p.hoverT = 0; });
    legend.appendChild(chip);
  });
  syncChips();
}

function syncChips() {
  const legend = document.getElementById('legend');
  [...legend.children].forEach(ch => {
    ch.dataset.on = parts[+ch.dataset.i].target > 0.5 ? 'true' : 'false';
  });
  document.getElementById('explodeBtn').dataset.on = parts.every(p => p.target > 0.5) ? 'true' : 'false';
}

// Specification specs updating
const PART_SPECS = {
  'Front wing': {
    cat: 'Aerodynamics &middot; Front',
    desc: 'Generates up to 35% of front downforce. Features adjustable carbon flaps and outwash endplates to route airflow around the front tires.',
    df: '35% Front', drag: 'Cd 0.18', mat: 'Carbon Prepreg', temp: '80°C'
  },
  'Rear wing': {
    cat: 'Aerodynamics &middot; Rear',
    desc: 'High-downforce dual-element wing equipped with hydraulic DRS (Drag Reduction System) to slash drag by 25% on straights.',
    df: '32% Rear', drag: 'Cd 0.28', mat: 'Carbon Prepreg', temp: '95°C'
  },
  'Nose': {
    cat: 'Chassis &middot; Impact',
    desc: 'Deformable carbon-fiber structure designed to absorb crash energy. Its shape optimizes entry flow to the floor tunnels.',
    df: '2% Front', drag: 'Cd 0.04', mat: 'Carbon Kevlar', temp: '65°C'
  },
  'Halo': {
    cat: 'Safety &middot; Cockpit',
    desc: 'The central survival cell housing the cockpit. The titanium Halo can withstand a 125 kN vertical load, safeguarding the driver.',
    df: '4% Total', drag: 'Cd 0.08', mat: 'Carbon-Honeycomb', temp: '75°C'
  },
  'Monocoque': {
    cat: 'Safety &middot; Survival Cell',
    desc: 'Main survival compartment. Carbon composite honeycombed tub protecting the fuel tank and driver cockpit.',
    df: '3% Total', drag: 'Cd 0.05', mat: 'Carbon Fiber', temp: '55°C'
  },
  'Engine cover': {
    cat: 'Power Unit Enclosure',
    desc: 'Encloses the 1.6L V6 Turbo Hybrid engine. The central shark fin stabilizes yaw alignment and guides air to the rear wing.',
    df: '5% Total', drag: 'Cd 0.09', mat: 'Zylon Backed CF', temp: '180°C'
  },
  'Sidepod L': {
    cat: 'Cooling &middot; Left Side',
    desc: 'Houses engine cooling radiators. Sculpted downwash channels direct high-velocity airflow over the floor edge.',
    df: '8% Total', drag: 'Cd 0.12', mat: 'Carbon Fiber', temp: '120°C'
  },
  'Sidepod R': {
    cat: 'Cooling &middot; Right Side',
    desc: 'Houses engine cooling radiators. Symmetrical downwash profile generates clean flow toward the diffuser.',
    df: '8% Total', drag: 'Cd 0.12', mat: 'Carbon Fiber', temp: '120°C'
  },
  'Floor': {
    cat: 'Ground Effect Aero',
    desc: 'Generates up to 60% of total downforce using Venturi tunnels under the car. Extremely efficient floor channel.',
    df: '60% Under', drag: 'Cd 0.08', mat: 'Reinforced CF', temp: '220°C'
  },
  'Wheel FL': {
    cat: 'Suspension &middot; Front-Left',
    desc: 'Pirelli P-Zero 18-inch wheel assembly. Connected via double-wishbone pushrod suspension. Features internal cooling ducts.',
    df: '-3% (Lift)', drag: 'Cd 0.15', mat: 'Magnesium Alloy', temp: '105°C'
  },
  'Wheel FR': {
    cat: 'Suspension &middot; Front-Right',
    desc: 'Pirelli P-Zero 18-inch wheel assembly. Dual-wishbone suspension connects hub to chassis. Calipers inside.',
    df: '-3% (Lift)', drag: 'Cd 0.15', mat: 'Magnesium Alloy', temp: '103°C'
  },
  'Wheel RL': {
    cat: 'Suspension &middot; Rear-Left',
    desc: 'Pirelli P-Zero rear drive wheel. Broader track width to handle engine torque. Pullrod suspension links.',
    df: '-1% (Lift)', drag: 'Cd 0.16', mat: 'Magnesium Alloy', temp: '98°C'
  },
  'Wheel RR': {
    cat: 'Suspension &middot; Rear-Right',
    desc: 'Pirelli P-Zero rear drive wheel. Connected to the gearbox casing via carbon pullrod suspension. Monitors pressure.',
    df: '-1% (Lift)', drag: 'Cd 0.16', mat: 'Magnesium Alloy', temp: '99°C'
  },
  'Suspension': {
    cat: 'Mechanical &middot; Suspension',
    desc: 'Carbon wishbone structural suspension. Bridges chassis to wheels. Manages vertical tire loads and pushrod vectors.',
    df: '2% Total', drag: 'Cd 0.05', mat: 'Carbon Composite', temp: '85°C'
  }
};

const hudEyebrow = document.getElementById('hudEyebrow');
const ptsValue = document.getElementById('ptsValue');
const ptsLabel = document.getElementById('ptsLabel');
const valDrag = document.getElementById('valDrag');
const valDf = document.getElementById('valDf');
const hudMarker = document.getElementById('hudMarker');
const hudName = document.getElementById('hudName');
const hudSub = document.getElementById('hudSub');

function updateDashboard(partMode) {
  if (!hudEyebrow) return;
  
  if (partMode === 'all') {
    hudEyebrow.textContent = 'Teardown Blueprint';
    ptsValue.innerHTML = '1.40<span class="unit">M PTS</span>';
    ptsLabel.textContent = 'Cloud Density';
    valDrag.innerHTML = '1.45<span class="unit">Cd</span>';
    valDf.innerHTML = 'Exploded<span class="unit">DF</span>';
    
    hudMarker.style.borderColor = '#ff9f43';
    hudMarker.style.boxShadow = '0 0 10px #ff9f43';
    
    hudName.textContent = 'FULL VEHICLE EXPLODED';
    hudSub.textContent = 'Multi-assembly Structural Layout';
  } else if (partMode && partMode.def) {
    const p = partMode;
    const spec = PART_SPECS[p.def.name] || { cat: 'Component', desc: 'No details available', df: 'N/A', drag: 'N/A' };
    
    hudEyebrow.textContent = 'Teardown Segment';
    
    const count = p.points.geometry.attributes.position.count;
    const kPts = (count / 1000).toFixed(0);
    ptsValue.innerHTML = kPts + '<span class="unit">K PTS</span>';
    ptsLabel.textContent = p.def.name.toUpperCase() + ' POINTS';
    
    const dragVal = spec.drag.replace('Cd ', '');
    valDrag.innerHTML = dragVal + '<span class="unit">Cd</span>';
    
    const dfVal = spec.df.replace(' DF', '').replace(' Total', '').replace(' Front', '').replace(' Rear', '').replace(' Under', '');
    valDf.innerHTML = dfVal + '<span class="unit">DF</span>';
    
    const rgb = 'rgb(' + (p.def.color[0]*255|0) + ',' + (p.def.color[1]*255|0) + ',' + (p.def.color[2]*255|0) + ')';
    hudMarker.style.borderColor = rgb;
    hudMarker.style.boxShadow = '0 0 10px ' + rgb;
    
    hudName.textContent = p.def.name.toUpperCase();
    hudSub.textContent = spec.cat.replace('&amp;', '&').replace('&middot;', '·');
  } else {
    hudEyebrow.textContent = 'Big Numbers';
    
    const totalM = (densityFraction * (totalPointsTarget / 1000000)).toFixed(2);
    ptsValue.innerHTML = totalM + '<span class="unit">M PTS</span>';
    ptsLabel.textContent = 'Cloud Density';
    valDrag.innerHTML = '0.82<span class="unit">Cd</span>';
    valDf.innerHTML = '12,450<span class="unit">N</span>';
    
    hudMarker.style.borderColor = '#fff';
    hudMarker.style.boxShadow = '0 0 0 3px rgba(255,255,255,.06)';
    
    hudName.textContent = 'RED BULL RB20';
    hudSub.textContent = '2024 Season · Surface-Sampled';
  }
}

// Button Bindings
const rotBtn = document.getElementById('rotBtn');
const explodeBtn = document.getElementById('explodeBtn');
const resetBtn = document.getElementById('resetBtn');
const toggleColorBtn = document.getElementById('toggleColorBtn');

rotBtn.addEventListener('click', () => { autoRotate = !autoRotate; rotBtn.dataset.on = autoRotate ? 'true' : 'false'; });
explodeBtn.addEventListener('click', () => {
  const allOn = parts.every(p => p.target > 0.5);
  parts.forEach(p => p.target = allOn ? 0 : 1);
  syncChips();
  updateDashboard(allOn ? null : 'all');
});
resetBtn.addEventListener('click', () => {
  parts.forEach(p => p.target = 0); syncChips();
  st.theta = 2.35; st.phi = 1.12;
  st.radius = Math.max(modelSize.x, modelSize.y, modelSize.z) * 1.6;
  updateDashboard(null);
});

toggleColorBtn.addEventListener('click', () => {
  colorMode = colorMode === 'livery' ? 'segmented' : 'livery';
  toggleColorBtn.dataset.on = colorMode === 'segmented' ? 'true' : 'false';
  toggleColorBtn.textContent = colorMode === 'segmented' ? 'Segmented Mode' : 'Livery Mode';
  
  parts.forEach(p => {
    const geo = p.points.geometry;
    const colorAttr = geo.attributes.color;
    colorAttr.array = colorMode === 'livery' ? p.liveryColors : p.segColors;
    colorAttr.needsUpdate = true;
  });
});

const densityInput = document.getElementById('density');
if (densityInput) {
  densityInput.addEventListener('input', e => {
    densityFraction = parseFloat(e.target.value) / 100;
    const opacity = 0.28 + 0.72 * densityFraction;
    
    const ptsValue = document.getElementById('ptsValue');
    if (ptsValue && document.getElementById('ptsLabel').textContent === "Cloud Density") {
      ptsValue.innerHTML = (densityFraction * (totalPointsTarget / 1000000)).toFixed(2) + '<span class="unit">M PTS</span>';
    }
    
    parts.forEach(p => {
      p.mat.opacity = opacity;
      p.mat.needsUpdate = true;
    });
  });
}

// Resize
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// Main Loop
const clock = new THREE.Clock();
let introTime = 0;
const introDuration = 1.8;
let introActive = false;

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  
  if (autoRotate && !dragging) st.theta += dt * 0.18;
  cur.theta += (st.theta - cur.theta) * 0.12;
  cur.phi += (st.phi - cur.phi) * 0.12;
  cur.radius += (st.radius - cur.radius) * 0.12;
  
  const sp = Math.sin(cur.phi), cp = Math.cos(cur.phi);
  camera.position.set(
    st.tgt.x + cur.radius * sp * Math.sin(cur.theta),
    st.tgt.y + cur.radius * cp,
    st.tgt.z + cur.radius * sp * Math.cos(cur.theta)
  );
  camera.lookAt(st.tgt);

  if (introActive) {
    introTime += dt;
    const t = Math.min(introTime / introDuration, 1.0);
    const ease = 1.0 - Math.pow(1.0 - t, 3); // cubic ease out
    
    parts.forEach(p => {
      p.points.scale.setScalar(ease);
      const introDisplacement = (1.0 - ease) * 3.5;
      const dir = p.def.dir;
      p.points.position.set(dir[0] * introDisplacement, dir[1] * introDisplacement, dir[2] * introDisplacement);
      
      p.hoverCur += (p.hoverT - p.hoverCur) * 0.2;
      p.mat.size = currentPointSize * (1.0 + p.hoverCur * 0.7);
      p.mat.color.setRGB(1.0 + p.hoverCur * 0.9, 1.0 + p.hoverCur * 0.9, 1.0 + p.hoverCur * 0.9);
    });
    
    if (t >= 1.0) {
      introActive = false;
      parts.forEach(p => p.points.scale.setScalar(1.0));
      // Start FPS counter after intro completes to avoid counting load/compile lag
      startTime = performance.now();
    }
  } else {
    // Normal update loop
    for (const p of parts) {
      p.cur += (p.target - p.cur) * 0.14;
      const dir = p.def.dir;
      p.points.position.set(dir[0] * p.cur, dir[1] * p.cur, dir[2] * p.cur);
      
      p.hoverCur += (p.hoverT - p.hoverCur) * 0.2;
      p.mat.size = currentPointSize * (1.0 + p.hoverCur * 0.7);
      p.mat.color.setRGB(1.0 + p.hoverCur * 0.9, 1.0 + p.hoverCur * 0.9, 1.0 + p.hoverCur * 0.9);
    }
    
    if (!hasProbed) {
      frameCount++;
      if (frameCount === 30) {
        const elapsed = performance.now() - startTime;
        const avgFps = 1000 / (elapsed / 30);
        console.log(`FPS Capability Probe result: ${avgFps.toFixed(1)} FPS`);
        if (avgFps < 45) {
          console.warn("FPS dropped below 45. Optimizing point count to 600k for smooth execution.");
          rebuildPointCloud(600000, 0.075);
        }
        hasProbed = true;
      }
    }
  }

  renderer.render(scene, camera);
}

const loaderBar = document.getElementById('loaderBar');
const loaderPct = document.getElementById('loaderPct');
const enterBtn = document.getElementById('enterBtn');

function updateLoader() {
  if (loaderComplete) return;
  
  const elapsed = performance.now() - loaderStart;
  let progress = Math.min(99, Math.round((elapsed / LOADER_DURATION) * 99));
  
  if (modelLoaded) {
    progress = Math.min(100, Math.round((elapsed / LOADER_DURATION) * 100));
    if (elapsed >= LOADER_DURATION) {
      progress = 100;
    }
  }
  
  if (loaderBar) loaderBar.style.width = progress + '%';
  if (loaderPct) loaderPct.textContent = progress;
  
  if (progress === 100 && modelLoaded) {
    loaderComplete = true;
    if (loaderBar) loaderBar.parentElement.style.opacity = '0';
    if (loaderPct) loaderPct.parentElement.style.opacity = '0';
    
    setTimeout(() => {
      if (enterBtn) enterBtn.classList.add('show');
    }, 300);
  } else {
    requestAnimationFrame(updateLoader);
  }
}

if (enterBtn) {
  enterBtn.addEventListener('click', () => {
    const loader = document.getElementById('loader');
    if (loader) loader.classList.add('hidden');
    
    if (loadedData) {
      buildModel(loadedData);
      initGround(Math.max(modelSize.x, modelSize.z));
      
      // Start cinematic intro
      introActive = true;
      introTime = 0;
    }
    
    window.__F1_READY = true;
  });
}

// Start Application
initApp();
updateLoader();
tick();
