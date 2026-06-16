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
let cameraVideo   = null;
let cameraStream  = null;

// ── Init ───────────────────────────────────────────────────────────────────────
function init() {
  buildModelList();
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
        <span class="model-meta">${m.width} × ${m.depth} ft · ${m.living.toLocaleString()} sqft</span>
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

function setNote(text) {
  const el = document.getElementById('arNote');
  if (el) el.textContent = text;
}

// ── Three.js setup ─────────────────────────────────────────────────────────────
function initThree() {
  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 200);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled        = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

  Object.assign(renderer.domElement.style, {
    position: 'fixed', inset: '0', width: '100%', height: '100%', zIndex: '2',
  });
  document.body.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 1.4));
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.0);
  sun.position.set(4, 8, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(1024);
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far  = 50;
  scene.add(sun);

  const ringGeo = new THREE.RingGeometry(0.12, 0.17, 36);
  ringGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  reticle = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);
}

// ── Start ──────────────────────────────────────────────────────────────────────
async function onStart() {
  // 1. Try WebXR immersive-ar
  const xrAvailable = navigator.xr
    && await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);

  if (xrAvailable) {
    const started = await tryWebXR();
    if (started) return;
  }

  // 2. Fall back to getUserMedia camera + device orientation
  await startCameraAR();
}

async function tryWebXR() {
  initThree();

  const overlay = document.getElementById('arOverlay');
  overlay.hidden = false;
  overlay.style.opacity = '0';

  try {
    xrSession = await navigator.xr.requestSession('immersive-ar', {
      optionalFeatures: ['hit-test', 'dom-overlay'],
      domOverlay: { root: overlay },
    });
  } catch {
    overlay.hidden = true;
    overlay.style.opacity = '';
    cleanupThree();
    return false;
  }

  overlay.style.opacity = '';
  renderer.xr.setReferenceSpaceType('local');
  await renderer.xr.setSession(xrSession);
  xrSession.addEventListener('end', onSessionEnd);

  try {
    const viewerSpace = await xrSession.requestReferenceSpace('viewer');
    hitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });
  } catch { /* no hit-test, tap-anywhere fallback */ }

  showARUI(selectedModel.name);
  renderer.domElement.addEventListener('click', onARTap);
  renderer.setAnimationLoop(renderFrame);
  return true;
}

// ── Camera AR (getUserMedia + DeviceOrientation) ────────────────────────────────
async function startCameraAR() {
  // Request camera
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    setNote(`Camera access denied: ${err.message}`);
    startPreview();
    return;
  }

  // Video element as background
  const video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.muted = true;
  Object.assign(video.style, {
    position: 'fixed', inset: '0', width: '100%', height: '100%',
    objectFit: 'cover', zIndex: '1',
  });
  video.srcObject = stream;
  document.body.appendChild(video);
  await video.play().catch(() => {});
  cameraVideo  = video;
  cameraStream = stream;

  initThree();
  camera.position.set(0, 1.6, 0); // approximate eye height in metres

  // Request device orientation permission (required on iOS 13+)
  if (typeof DeviceOrientationEvent !== 'undefined'
      && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try { await DeviceOrientationEvent.requestPermission(); } catch { /* denied or unavailable */ }
  }
  window.addEventListener('deviceorientation', onDeviceOrientation);

  showARUI(selectedModel.name);
  setHint('tapAnywhere');
  document.addEventListener('touchend', onDocumentTap, { passive: true });
  renderer.setAnimationLoop(() => renderer.render(scene, camera));
}

function onDeviceOrientation(e) {
  if (!camera) return;
  const R = THREE.MathUtils.degToRad;
  camera.rotation.order = 'YXZ';
  camera.rotation.y = R(-(e.alpha ?? 0));
  camera.rotation.x = R((e.beta  ?? 90) - 90);
  camera.rotation.z = R(-(e.gamma ?? 0));
}

function onDocumentTap(e) {
  // Ignore taps on UI buttons
  if (e.target.closest('#exitBtn, #replaceBtn')) return;
  onCameraTap();
}

function onCameraTap() {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);

  // Try ground-plane intersection first
  let groundPt;
  if (Math.abs(forward.y) > 0.05) {
    const t = -camera.position.y / forward.y;
    if (t > 0.5 && t < 25) {
      groundPt = camera.position.clone().addScaledVector(forward, t);
    }
  }

  // Fallback: 4 m straight ahead at ground level
  if (!groundPt) {
    const horiz = forward.clone(); horiz.y = 0; horiz.normalize();
    groundPt = camera.position.clone().addScaledVector(horiz, 4);
    groundPt.y = 0;
  }

  disposeModel(placedModel);
  placedModel = buildADUModel(selectedModel);
  placedModel.position.copy(groundPt);
  placedModel.rotation.y = Math.atan2(
    camera.position.x - groundPt.x,
    camera.position.z - groundPt.z
  );
  scene.add(placedModel);
  isPlaced = true;
  showPlacedUI();
}

// ── WebXR render loop ──────────────────────────────────────────────────────────
function renderFrame(_, frame) {
  if (frame) {
    if (hitTestSource && !isPlaced) {
      const results = frame.getHitTestResults(hitTestSource);
      if (results.length > 0) {
        const pose = results[0].getPose(renderer.xr.getReferenceSpace());
        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
        setHint('tap');
      } else {
        reticle.visible = false;
        setHint('scan');
      }
    } else if (!hitTestSource && !isPlaced) {
      setHint('tapAnywhere');
    }
  }
  renderer.render(scene, camera);
}

// ── WebXR tap to place ─────────────────────────────────────────────────────────
function onARTap() {
  if (hitTestSource && !reticle.visible) return;

  disposeModel(placedModel);
  placedModel = buildADUModel(selectedModel);

  if (reticle.visible) {
    const pos  = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    reticle.matrix.decompose(pos, quat, new THREE.Vector3());
    placedModel.position.copy(pos);
    placedModel.rotation.y = new THREE.Euler().setFromQuaternion(quat).y;
  } else {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    forward.y = 0; forward.normalize();
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
  setHint(hitTestSource ? 'scan' : 'tapAnywhere');
}

// ── 3D preview fallback (no camera) ───────────────────────────────────────────
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

  renderer.setAnimationLoop(() => { orbitControls.update(); renderer.render(scene, camera); });
}

// ── Model geometry ─────────────────────────────────────────────────────────────
function buildADUModel(config) {
  const W = config.width * 0.3048;
  const D = config.depth * 0.3048;
  const H = 2.9, RT = 0.14, OV = 0.28;

  const group = new THREE.Group();

  const wallGeo = new THREE.BoxGeometry(W, H, D);
  const wall = new THREE.Mesh(wallGeo, new THREE.MeshLambertMaterial({ color: 0xf0ebe0 }));
  wall.position.y = H / 2;
  wall.castShadow = wall.receiveShadow = true;
  group.add(wall);

  group.add(Object.assign(
    new THREE.LineSegments(new THREE.EdgesGeometry(wallGeo), new THREE.LineBasicMaterial({ color: 0xbdb4aa })),
    { position: { y: H / 2 } }
  ));

  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(W + OV * 2, RT, D + OV * 2),
    new THREE.MeshLambertMaterial({ color: 0x383330 })
  );
  roof.position.y = H + RT / 2;
  roof.castShadow = true;
  group.add(roof);

  const fp = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshBasicMaterial({ color: 0x4d87d6, transparent: true, opacity: 0.14, side: THREE.DoubleSide })
  );
  fp.rotation.x = -Math.PI / 2; fp.position.y = 0.004;
  group.add(fp);

  const fpEdge = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(W, D)),
    new THREE.LineBasicMaterial({ color: 0x4d87d6, transparent: true, opacity: 0.5 })
  );
  fpEdge.rotation.x = -Math.PI / 2; fpEdge.position.y = 0.006;
  group.add(fpEdge);

  return group;
}

// ── UI helpers ─────────────────────────────────────────────────────────────────
function showARUI(modelName) {
  document.getElementById('home').style.display = 'none';
  document.getElementById('arOverlay').hidden   = false;
  document.getElementById('arModelName').textContent = modelName;
}

function showPlacedUI() {
  document.getElementById('arHintWrap').style.display = 'none';
  document.getElementById('arDims').hidden    = false;
  document.getElementById('arDims').textContent = dimsLabel(selectedModel);
  document.getElementById('arActions').hidden = false;
}

function setHint(type) {
  const hint = document.getElementById('arHint');
  if (type === 'scan')       { hint.textContent = 'Move slowly to detect the ground'; hint.classList.remove('ready'); }
  else if (type === 'tap')   { hint.textContent = 'Tap to place';                     hint.classList.add('ready'); }
  else                       { hint.textContent = 'Tap to place in your backyard';    hint.classList.add('ready'); }
}

function dimsLabel(m) { return `${m.width} × ${m.depth} ft · ${m.living.toLocaleString()} sqft`; }

// ── Exit & cleanup ─────────────────────────────────────────────────────────────
function onExit() {
  xrSession ? xrSession.end() : onSessionEnd();
}

function onSessionEnd() {
  renderer?.setAnimationLoop(null);
  window.removeEventListener('deviceorientation', onDeviceOrientation);
  document.removeEventListener('touchend', onDocumentTap);
  orbitControls?.dispose(); orbitControls = null;
  disposeModel(placedModel); placedModel = null;
  cameraStream?.getTracks().forEach(t => t.stop()); cameraStream = null;
  cameraVideo?.remove(); cameraVideo = null;
  cleanupThree();
  hitTestSource = null; xrSession = null; isPlaced = false; reticle = null;

  const home = document.getElementById('home');
  home.style.display = '';
  document.getElementById('arOverlay').hidden         = true;
  document.getElementById('arHintWrap').style.display = '';
  document.getElementById('arDims').hidden            = true;
  document.getElementById('arActions').hidden         = true;
}

function cleanupThree() {
  renderer?.domElement.remove();
  renderer?.dispose();
  renderer = null; scene = null; camera = null;
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
