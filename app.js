import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ADU_MODELS } from './config.js';

// ── State ──────────────────────────────────────────────────────────────────────
let selectedModel = ADU_MODELS[0];
let xrSession     = null;
let hitTestSource = null;
let renderer      = null;
let scene         = null;
let camera        = null;
let reticle       = null;
let placedModel   = null;
let isPlaced      = false;
let orbitControls = null;

// ── Init ───────────────────────────────────────────────────────────────────────
function init() {
  buildModelList();
  checkARSupport();
  document.getElementById('startBtn').addEventListener('click', onStart);
  document.getElementById('exitBtn').addEventListener('click', onExit);
  document.getElementById('replaceBtn').addEventListener('click', onReplace);
}

// ── Model list ─────────────────────────────────────────────────────────────────
function buildModelList() {
  const list = document.getElementById('modelList');
  ADU_MODELS.forEach(m => {
    const card = document.createElement('div');
    card.className = 'model-card';
    card.dataset.id = m.id;
    card.innerHTML = `
      <div class="model-info">
        <span class="model-name">${m.name}</span>
        <span class="model-meta">${m.width} × ${m.depth} ft · ${m.living.toLocaleString()} sqft</span>
      </div>
      <div class="model-check">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>`;
    card.addEventListener('click', () => selectModel(m));
    list.appendChild(card);
  });
  selectModel(selectedModel);
}

function selectModel(model) {
  selectedModel = model;
  document.querySelectorAll('.model-card').forEach(c =>
    c.classList.toggle('selected', c.dataset.id === model.id)
  );
}

// ── AR support check ───────────────────────────────────────────────────────────
async function checkARSupport() {
  if (!navigator.xr) {
    document.querySelector('#startBtn .btn-label').textContent = 'Preview in 3D';
    setNote('No WebXR. Use Chrome on Android or Safari on iOS 16.4+.');
    return;
  }
  const ok = await navigator.xr.isSessionSupported('immersive-ar').catch(e => {
    setNote(`Support check failed: ${e.message}`);
    return false;
  });
  if (ok) {
    setNote('AR ready — tap to open camera.');
  } else {
    document.querySelector('#startBtn .btn-label').textContent = 'Preview in 3D';
    setNote('immersive-ar not supported. iPhone: Settings → Safari → Advanced → Experimental Features → WebXR Device API → ON.');
  }
}

function setNote(text) {
  const el = document.getElementById('arNote');
  if (el) el.textContent = text;
}

// ── Three.js setup ─────────────────────────────────────────────────────────────
function initThree() {
  scene    = new THREE.Scene();
  camera   = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 200);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled   = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

  const s = renderer.domElement.style;
  s.position = 'fixed'; s.inset = '0';
  s.width = '100%'; s.height = '100%';
  s.zIndex = '1';
  document.body.appendChild(renderer.domElement);

  // Lighting
  scene.add(new THREE.AmbientLight(0xffffff, 1.4));
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.0);
  sun.position.set(4, 8, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(1024);
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far  = 50;
  scene.add(sun);

  // Reticle — a flat ring that hugs the detected surface
  const ringGeo = new THREE.RingGeometry(0.12, 0.17, 36);
  ringGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  reticle = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
    color: 0xffffff, side: THREE.DoubleSide
  }));
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);
}

// ── Start ──────────────────────────────────────────────────────────────────────
async function onStart() {
  const arAvailable = navigator.xr
    && await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);

  if (!arAvailable) { startPreview(); return; }

  initThree();

  // Overlay must be visible (not display:none) before passing as domOverlay root
  const overlay = document.getElementById('arOverlay');
  overlay.hidden = false;
  overlay.style.opacity = '0';

  try {
    xrSession = await navigator.xr.requestSession('immersive-ar', {
      optionalFeatures: ['hit-test', 'dom-overlay'],
      domOverlay: { root: overlay },
    });
  } catch (err) {
    overlay.hidden = true;
    overlay.style.opacity = '';
    cleanupThree();
    setNote(`Could not start AR: ${err?.message || err}. Try Chrome on Android or Safari on iOS 16.4+.`);
    return;
  }

  overlay.style.opacity = '';

  renderer.xr.setReferenceSpaceType('local');
  await renderer.xr.setSession(xrSession);
  xrSession.addEventListener('end', onSessionEnd);

  try {
    const viewerSpace = await xrSession.requestReferenceSpace('viewer');
    hitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });
  } catch { /* hit-test unavailable — tap places at fixed distance */ }

  showARUI(selectedModel.name);
  renderer.domElement.addEventListener('click', onARTap);
  renderer.setAnimationLoop(renderFrame);
}

// ── AR render loop ─────────────────────────────────────────────────────────────
function renderFrame(_, frame) {
  if (frame) {
    if (hitTestSource && !isPlaced) {
      const refSpace = renderer.xr.getReferenceSpace();
      const results  = frame.getHitTestResults(hitTestSource);
      if (results.length > 0) {
        const pose = results[0].getPose(refSpace);
        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
        setHint('tap');
      } else {
        reticle.visible = false;
        setHint('scan');
      }
    } else if (!hitTestSource && !isPlaced) {
      // No hit-test: prompt tap-anywhere placement
      setHint('tapAnywhere');
    }
  }
  renderer.render(scene, camera);
}

// ── Tap to place ───────────────────────────────────────────────────────────────
function onARTap() {
  // With hit-test: must wait for reticle
  if (hitTestSource && !reticle.visible) return;

  disposeModel(placedModel);
  placedModel = buildADUModel(selectedModel);

  if (reticle.visible) {
    // Place at hit-test surface point
    const pos  = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    reticle.matrix.decompose(pos, quat, new THREE.Vector3());
    placedModel.position.copy(pos);
    placedModel.rotation.y = new THREE.Euler().setFromQuaternion(quat).y;
  } else {
    // Fallback: project 3 m in front of camera onto y = 0 ground plane
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    forward.y = 0;
    forward.normalize();
    const camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    placedModel.position.copy(camPos).addScaledVector(forward, 3);
    placedModel.position.y = 0;
  }

  scene.add(placedModel);

  isPlaced = true;
  reticle.visible = false;
  showPlacedUI();
}

function onReplace() {
  isPlaced = false;
  reticle.visible = false;
  document.getElementById('arHintWrap').style.display = '';
  document.getElementById('arDims').hidden    = true;
  document.getElementById('arActions').hidden = true;
  setHint('scan');
}

// ── 3D preview fallback ────────────────────────────────────────────────────────
function startPreview() {
  initThree();
  scene.background = new THREE.Color(0x111111);
  camera.position.set(7, 6, 10);

  scene.add(new THREE.GridHelper(40, 40, 0x333333, 0x222222));

  placedModel = buildADUModel(selectedModel);
  scene.add(placedModel);

  orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.target.set(0, 1.4, 0);
  orbitControls.enableDamping = true;
  orbitControls.update();

  showARUI(`${selectedModel.name} — 3D Preview`);
  document.getElementById('arHintWrap').style.display = 'none';
  document.getElementById('arDims').hidden    = false;
  document.getElementById('arDims').textContent = dimsLabel(selectedModel);

  renderer.setAnimationLoop(() => {
    orbitControls.update();
    renderer.render(scene, camera);
  });
}

// ── Model geometry ─────────────────────────────────────────────────────────────
function buildADUModel(config) {
  const W  = config.width  * 0.3048;  // feet → metres
  const D  = config.depth  * 0.3048;
  const H  = 2.9;   // ~9.5 ft wall height
  const RT = 0.14;  // roof slab thickness
  const OV = 0.28;  // roof overhang each side

  const group = new THREE.Group();

  // Walls
  const wallGeo = new THREE.BoxGeometry(W, H, D);
  const wall    = new THREE.Mesh(wallGeo, new THREE.MeshLambertMaterial({ color: 0xf0ebe0 }));
  wall.position.y = H / 2;
  wall.castShadow    = true;
  wall.receiveShadow = true;
  group.add(wall);

  // Crisp edge lines
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(wallGeo),
    new THREE.LineBasicMaterial({ color: 0xbdb4aa })
  );
  edges.position.y = H / 2;
  group.add(edges);

  // Flat roof slab (modern ADU style)
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(W + OV * 2, RT, D + OV * 2),
    new THREE.MeshLambertMaterial({ color: 0x383330 })
  );
  roof.position.y = H + RT / 2;
  roof.castShadow = true;
  group.add(roof);

  // Ground footprint fill
  const fp = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshBasicMaterial({ color: 0x4d87d6, transparent: true, opacity: 0.14, side: THREE.DoubleSide })
  );
  fp.rotation.x = -Math.PI / 2;
  fp.position.y = 0.004;
  group.add(fp);

  // Footprint border
  const fpEdge = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(W, D)),
    new THREE.LineBasicMaterial({ color: 0x4d87d6, transparent: true, opacity: 0.5 })
  );
  fpEdge.rotation.x = -Math.PI / 2;
  fpEdge.position.y  = 0.006;
  group.add(fpEdge);

  return group;
}

// ── UI helpers ─────────────────────────────────────────────────────────────────
function showARUI(modelName) {
  document.getElementById('home').style.display = 'none';
  document.getElementById('arOverlay').hidden   = false;
  document.getElementById('arModelName').textContent = modelName;
  setHint('scan');
}

function showPlacedUI() {
  document.getElementById('arHintWrap').style.display = 'none';
  document.getElementById('arDims').hidden    = false;
  document.getElementById('arDims').textContent = dimsLabel(selectedModel);
  document.getElementById('arActions').hidden = false;
}

function setHint(type) {
  const hint = document.getElementById('arHint');
  if (type === 'scan') {
    hint.textContent = 'Move slowly to detect the ground';
    hint.classList.remove('ready');
  } else if (type === 'tap') {
    hint.textContent = 'Tap to place';
    hint.classList.add('ready');
  } else if (type === 'tapAnywhere') {
    hint.textContent = 'Tap to place in front of you';
    hint.classList.add('ready');
  }
}

function dimsLabel(m) {
  return `${m.width} × ${m.depth} ft · ${m.living.toLocaleString()} sqft`;
}

// ── Exit ───────────────────────────────────────────────────────────────────────
function onExit() {
  xrSession ? xrSession.end() : onSessionEnd();
}

function onSessionEnd() {
  renderer.setAnimationLoop(null);
  orbitControls?.dispose();
  orbitControls = null;
  disposeModel(placedModel);
  placedModel = null;
  cleanupThree();
  hitTestSource = null;
  xrSession     = null;
  isPlaced      = false;
  reticle       = null;

  const home = document.getElementById('home');
  home.hidden        = false;
  home.style.display = '';
  document.getElementById('arOverlay').hidden    = true;
  document.getElementById('arHintWrap').style.display = '';
  document.getElementById('arDims').hidden       = true;
  document.getElementById('arActions').hidden    = true;
}

function cleanupThree() {
  renderer?.domElement.remove();
  renderer?.dispose();
  renderer = null;
  scene    = null;
  camera   = null;
}

function disposeModel(obj) {
  if (!obj) return;
  obj.traverse(o => {
    o.geometry?.dispose();
    if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
    else o.material?.dispose();
  });
  scene?.remove(obj);
}

init();
