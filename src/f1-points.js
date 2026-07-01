// f1-points.js
// Converts a real F1 GLB/GLTF model into a segmented point cloud.
// Output plugs straight into the existing viewer: for each logical part you get
// positions + TWO colour buffers (livery + segmented) + an explode direction.
//
// Requires three r150+ and the addons GLTFLoader, MeshSurfaceSampler, DRACOLoader.
// Written framework-agnostic (Vite import paths shown; adjust if using importmap).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// ---------------------------------------------------------------------------
// PART RULES
// Map mesh/material names from YOUR model to logical, explodable parts.
// Inspect the model first (console.log every mesh.name) and tune the regexes.
// `seg` = the vivid segmented-mode colour. `dir` (optional) overrides the
// auto-computed explode direction (units are model-space, pre-normalisation).
// ---------------------------------------------------------------------------
export const PART_RULES = [
  { part: 'Front wing',       seg: [1.00, 0.46, 0.12], dir: [ 0.0, -0.2,  2.4] },
  { part: 'Rear wing',        seg: [1.00, 0.50, 0.12], dir: [ 0.0,  0.4, -2.4] },
  { part: 'Nose',             seg: [0.86, 0.95, 1.00], dir: [ 0.0,  0.1,  2.1] },
  { part: 'Halo',             seg: [0.30, 1.00, 0.55], dir: [ 0.0,  1.4,  0.0] },
  { part: 'Monocoque',        seg: [0.25, 0.95, 0.72], dir: [ 0.0,  1.2,  0.0] },
  { part: 'Engine cover',     seg: [1.00, 0.28, 0.30], dir: [ 0.0,  1.3, -0.4] },
  { part: 'Sidepod L',        seg: [0.24, 0.52, 1.00], dir: [ 2.1,  0.0,  0.0] },
  { part: 'Sidepod R',        seg: [0.24, 0.52, 1.00], dir: [-2.1,  0.0,  0.0] },
  { part: 'Floor',            seg: [0.16, 0.66, 0.62], dir: [ 0.0, -1.6,  0.0] },
  { part: 'Wheel FL',         seg: [0.62, 0.34, 1.00], dir: [ 1.9,  0.2,  0.4] },
  { part: 'Wheel FR',         seg: [0.62, 0.34, 1.00], dir: [-1.9,  0.2,  0.4] },
  { part: 'Wheel RL',         seg: [1.00, 0.24, 0.70], dir: [ 1.9,  0.2, -0.4] },
  { part: 'Wheel RR',         seg: [1.00, 0.24, 0.70], dir: [-1.9,  0.2, -0.4] },
  { part: 'Suspension',       seg: [0.80, 0.80, 0.85], dir: [ 0.0,  0.0,  0.0] },
];
const FALLBACK = { part: 'Monocoque', seg: [0.25, 0.95, 0.72], dir: [0.0, 1.2, 0.0] };

// ---------------------------------------------------------------------------
// Texture -> canvas cache, so we can read a pixel colour at a UV coordinate.
// ---------------------------------------------------------------------------
const _texCache = new Map();
function textureReader(texture) {
  if (!texture || !texture.image) return null;
  if (_texCache.has(texture.uuid)) return _texCache.get(texture.uuid);
  const img = texture.image;
  const w = img.width || 1024, h = img.height || 1024;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  try { ctx.drawImage(img, 0, 0, w, h); } catch (e) { _texCache.set(texture.uuid, null); return null; }
  const data = ctx.getImageData(0, 0, w, h).data;
  const reader = { data, w, h };
  _texCache.set(texture.uuid, reader);
  return reader;
}
function readTexel(reader, u, v, out) {
  const w = reader.w, h = reader.h;
  let x = Math.floor((u - Math.floor(u)) * w);
  let y = Math.floor((1 - (v - Math.floor(v))) * h);
  x = Math.max(0, Math.min(w - 1, x));
  y = Math.max(0, Math.min(h - 1, y));
  const i = (y * w + x) * 4;
  out[0] = reader.data[i]     / 255;
  out[1] = reader.data[i + 1] / 255;
  out[2] = reader.data[i + 2] / 255;
}

// sRGB -> linear so sampled texels match how three renders them
function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }

// ---------------------------------------------------------------------------
// MAIN: load a model and return per-part point clouds.
// ---------------------------------------------------------------------------
export async function loadF1Points(url, opts = {}) {
  const {
    totalPoints = 900000,   // raise to ~1.4M for hero crispness on desktop
    dracoPath = null,       // set if the GLB is DRACO-compressed
    liveryBoost = 1.08,     // brighten sampled livery a touch for the dark studio
    onProgress = null,
  } = opts;

  const loader = new GLTFLoader();
  if (dracoPath) { const d = new DRACOLoader(); d.setDecoderPath(dracoPath); loader.setDRACOLoader(d); }

  const gltf = await loader.loadAsync(url);
  const root = gltf.scene;
  root.updateWorldMatrix(true, true);

  // Collect renderable meshes
  const meshes = [];
  root.traverse(o => { if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o); });
  if (!meshes.length) throw new Error('No meshes found in model');

  // Overall bounds / centre (for auto explode directions)
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  // Group meshes into logical parts
  const groups = new Map();
  for (const m of meshes) {
    const meshBox = new THREE.Box3().setFromObject(m);
    const meshCenter = meshBox.getCenter(new THREE.Vector3());
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    const matName = mat && mat.name ? mat.name : "";
    
    let partName = "Monocoque";
    
    if (/rim|tire|wheel|flask|fix_roue/i.test(matName)) {
      if (meshCenter.z > center.z + size.z * 0.05) {
        partName = (meshCenter.x > center.x) ? "Wheel FL" : "Wheel FR";
      } else {
        partName = (meshCenter.x > center.x) ? "Wheel RL" : "Wheel RR";
      }
    } else if (/suspension/i.test(matName)) {
      partName = "Suspension";
    } else if (/exhaust|gearbox/i.test(matName)) {
      partName = "Rear wing";
    } else if (/glass/i.test(matName) && meshCenter.y > center.y) {
      partName = "Halo";
    } else if (meshCenter.z > center.z + size.z * 0.4) {
      partName = "Front wing";
    } else if (meshCenter.z > center.z + size.z * 0.22 && meshCenter.z <= center.z + size.z * 0.4 && meshCenter.y < center.y + size.y * 0.1) {
      partName = "Nose";
    } else if (meshCenter.z < center.z - size.z * 0.32) {
      partName = "Rear wing";
    } else if (meshCenter.y < center.y - size.y * 0.2 && Math.abs(meshCenter.x) < size.x * 0.42) {
      partName = "Floor";
    } else if (meshCenter.z > center.z - size.z * 0.32 && meshCenter.z <= center.z + size.z * 0.22) {
      if (Math.abs(meshCenter.x - center.x) > size.x * 0.18) {
        partName = (meshCenter.x > center.x) ? "Sidepod L" : "Sidepod R";
      } else if (meshCenter.y > center.y + size.y * 0.15) {
        partName = "Engine cover";
      } else {
        partName = "Monocoque";
      }
    }
    
    const rule = PART_RULES.find(r => r.part === partName) || FALLBACK;
    if (!groups.has(rule.part)) {
      groups.set(rule.part, { part: rule.part, seg: rule.seg, dir: rule.dir, meshes: [] });
    }
    groups.get(rule.part).meshes.push(m);
  }

  // Distribute the point budget across all meshes by surface area
  const areaOf = (mesh) => {
    const g = mesh.geometry;
    const pos = g.attributes.position, idx = g.index;
    const tris = idx ? idx.count / 3 : pos.count / 3;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(),
          ab = new THREE.Vector3(), ac = new THREE.Vector3(), cr = new THREE.Vector3();
    const s = mesh.matrixWorld;
    let total = 0;
    for (let i = 0; i < tris; i++) {
      let i0, i1, i2;
      if (idx) { i0 = idx.getX(i*3); i1 = idx.getX(i*3+1); i2 = idx.getX(i*3+2); }
      else { i0 = i*3; i1 = i*3+1; i2 = i*3+2; }
      a.fromBufferAttribute(pos, i0).applyMatrix4(s);
      b.fromBufferAttribute(pos, i1).applyMatrix4(s);
      c.fromBufferAttribute(pos, i2).applyMatrix4(s);
      ab.subVectors(b, a); ac.subVectors(c, a); cr.crossVectors(ab, ac);
      total += cr.length() * 0.5;
    }
    return total;
  };

  let grandArea = 0;
  const meshArea = new Map();
  for (const m of meshes) { const ar = areaOf(m) || 1e-6; meshArea.set(m, ar); grandArea += ar; }

  const _p = new THREE.Vector3(), _n = new THREE.Vector3(), _uv = new THREE.Vector2();
  const texel = [0, 0, 0];

  const parts = [];
  let done = 0;

  for (const g of groups.values()) {
    const posArr = [], livArr = [], centroid = new THREE.Vector3();

    for (const mesh of g.meshes) {
      const count = Math.max(500, Math.round(totalPoints * (meshArea.get(mesh) / grandArea)));

      // Bake world matrix into a temp geometry so sampled points are world-space
      const geo = mesh.geometry.clone();
      geo.applyMatrix4(mesh.matrixWorld);
      const tmp = new THREE.Mesh(geo, mesh.material);

      const sampler = new MeshSurfaceSampler(tmp);
      // weight by geometry vertex colour only if present; area weighting is default
      sampler.build();

      // Livery colour source: base texture map, else flat material colour
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const reader = mat && mat.map ? textureReader(mat.map) : null;
      const base = new THREE.Color();
      if (mat && mat.color) base.copy(mat.color); else base.setRGB(0.6, 0.6, 0.6);

      const hasUV = !!geo.attributes.uv;

      for (let i = 0; i < count; i++) {
        // sample(position, normal, color, uv) - uv arg supported in three r150+
        if (reader && hasUV) sampler.sample(_p, _n, null, _uv);
        else sampler.sample(_p, _n);

        posArr.push(_p.x, _p.y, _p.z);
        centroid.add(_p);

        let r, gg, b;
        if (reader && hasUV) {
          readTexel(reader, _uv.x, _uv.y, texel);
          r = srgbToLinear(texel[0]); gg = srgbToLinear(texel[1]); b = srgbToLinear(texel[2]);
        } else { r = base.r; gg = base.g; b = base.b; }
        const j = 0.85 + Math.random() * 0.3; // subtle grain
        livArr.push(
          Math.min(1, r * liveryBoost * j),
          Math.min(1, gg * liveryBoost * j),
          Math.min(1, b * liveryBoost * j)
        );
      }
      geo.dispose();
    }

    const N = posArr.length / 3;
    centroid.multiplyScalar(1 / N);

    // Segmented-mode colour buffer (flat per-part with grain)
    const seg = new Float32Array(posArr.length);
    const [sr, sg, sb] = g.seg;
    for (let i = 0; i < N; i++) {
      const j = 0.75 + Math.random() * 0.4;
      seg[i*3] = sr*j; seg[i*3+1] = sg*j; seg[i*3+2] = sb*j;
    }

    // Explode direction: rule override, else radial from car centre + gravity bias
    let dir;
    if (g.dir) dir = new THREE.Vector3(g.dir[0], g.dir[1], g.dir[2]);
    else {
      dir = centroid.clone().sub(center);
      if (dir.lengthSq() < 1e-4) dir.set(0, 1, 0);
      dir.normalize();
    }
    // Scale explode distance to model size
    dir.multiplyScalar(Math.max(size.x, size.y, size.z) * 0.28);

    parts.push({
      name: g.part,
      segColor: g.seg,
      positions: new Float32Array(posArr),
      liveryColors: new Float32Array(livArr),
      segColors: seg,
      centroid,
      dir: [dir.x, dir.y, dir.z],
      count: N,
    });

    done++;
    if (onProgress) onProgress(done / groups.size, g.part);
  }

  return { center: [center.x, center.y, center.z], size: [size.x, size.y, size.z], parts };
}
