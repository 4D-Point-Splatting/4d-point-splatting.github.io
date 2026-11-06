// A10: interactive fitted scene. Loads static/viewer/<seq>.{json,bin} (tools/export_viewer.py) when the section
// scrolls into view. Radar world (x right, y boresight, z up) maps to three.js y-up as (x, z, -y).
import * as THREE from './three.module.min.js';
import { OrbitControls } from './OrbitControls.js';

const wrap = document.getElementById('viewer-wrap');
const loading = document.getElementById('viewer-loading');
const slider = document.getElementById('viewer-time');
const readout = document.getElementById('viewer-readout');
const playBtn = document.getElementById('viewer-play');
const chips = document.getElementById('viewer-chips');
if (wrap) init();

function init() {
  let started = false;
  const io = new IntersectionObserver((es) => {
    if (!started && es.some((e) => e.isIntersecting)) { started = true; start(); io.disconnect(); }
  }, { rootMargin: '200px' });
  io.observe(wrap);
}

const BG = { light: 0xf5f5f7, dark: 0x26272c };
const SCENE_GREY = [150, 150, 158], PERSON_GREY = [98, 110, 128];
// figures/fig_common.VELOCITY_CMAP: blue (toward) - grey - red (away)
const VEL = [[0x2f, 0x4f, 0xb0], [0x8a, 0x8a, 0x8a], [0xb8, 0x32, 0x2a]];

function velColour(v, out, i) {             // v in [-1, 1]
  const t = (v + 1) / 2, a = t < 0.5 ? VEL[0] : VEL[1], b = t < 0.5 ? VEL[1] : VEL[2], u = t < 0.5 ? t * 2 : t * 2 - 1;
  out[i] = (a[0] + (b[0] - a[0]) * u) / 255; out[i + 1] = (a[1] + (b[1] - a[1]) * u) / 255; out[i + 2] = (a[2] + (b[2] - a[2]) * u) / 255;
}

function discTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'); const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.72, 'rgba(255,255,255,1)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.beginPath(); g.arc(32, 32, 32, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function start() {
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
  catch (e) { loading.textContent = 'This browser cannot create a WebGL context, so the 3-D viewer is unavailable.'; return; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  wrap.insertBefore(renderer.domElement, wrap.firstChild);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  const sprite = discTexture();
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.2, 0.024), new THREE.MeshBasicMaterial({ color: 0x2f6b3a }));
  scene.add(board);
  let data = null, sceneObj = null, personObj = null, colourMode = 'geometry', playing = true, frame = 0, acc = 0;
  let last = performance.now();

  function theme() { return (window.fdpsTheme && window.fdpsTheme()) || 'light'; }
  function applyTheme() { scene.background = new THREE.Color(BG[theme()]); }
  window.addEventListener('fdps-theme', applyTheme);
  applyTheme();

  function resize() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  function pointsMaterial(size) {
    return new THREE.PointsMaterial({ size, vertexColors: true, map: sprite, alphaTest: 0.5, transparent: false, sizeAttenuation: true });
  }

  async function load(seq) {
    loading.style.display = 'flex';
    const meta = await (await fetch(`./static/viewer/${seq}.json`)).json();
    const buf = await (await fetch(`./static/viewer/${seq}.bin`)).arrayBuffer();
    const o = meta.offsets, view = (T, k) => new T(buf, o[k][0], o[k][1] / T.BYTES_PER_ELEMENT);
    data = { meta, scenePos: view(Float32Array, 'scene_pos'), sceneNrm: view(Uint8Array, 'scene_nrm'),
             sceneMat: view(Uint8Array, 'scene_mat'), personPos: view(Int16Array, 'person_pos'),
             personNrm: view(Uint8Array, 'person_nrm'), personVel: view(Int8Array, 'person_vel') };
    if (sceneObj) { scene.remove(sceneObj); sceneObj.geometry.dispose(); }
    if (personObj) { scene.remove(personObj); personObj.geometry.dispose(); }
    const Ns = meta.scene_points, Np = meta.person_points;
    const sg = new THREE.BufferGeometry(), sp = new Float32Array(Ns * 3);
    for (let i = 0; i < Ns; i++) { sp[3 * i] = data.scenePos[3 * i]; sp[3 * i + 1] = data.scenePos[3 * i + 2]; sp[3 * i + 2] = -data.scenePos[3 * i + 1]; }
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    sg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(Ns * 3), 3));
    sceneObj = new THREE.Points(sg, pointsMaterial(0.03)); scene.add(sceneObj);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Np * 3), 3));
    pg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(Np * 3), 3));
    personObj = new THREE.Points(pg, pointsMaterial(0.022)); scene.add(personObj);
    slider.max = meta.frames - 1; frame = 0;
    // camera: from the radar's side, above, looking at the person's mean position
    const b0 = meta.bbox_min, b1 = meta.bbox_max;
    const c = new THREE.Vector3((b0[0] + b1[0]) / 2, (b0[2] + b1[2]) / 2, -(b0[1] + b1[1]) / 2);
    controls.target.copy(c);
    camera.position.set(c.x + 2.2, c.y + 1.6, c.z + 3.6);
    controls.update();
    colourScene(); setFrame(0);
    loading.style.display = 'none';
  }

  function colourScene() {
    const Ns = data.meta.scene_points, col = sceneObj.geometry.attributes.color.array;
    for (let i = 0; i < Ns; i++) {
      let r, g, b;
      if (colourMode === 'normals') { r = data.sceneNrm[3 * i]; g = data.sceneNrm[3 * i + 1]; b = data.sceneNrm[3 * i + 2]; }
      else if (colourMode === 'materials') { r = data.sceneMat[3 * i]; g = data.sceneMat[3 * i + 1]; b = data.sceneMat[3 * i + 2]; }
      else { [r, g, b] = SCENE_GREY; }
      col[3 * i] = r / 255; col[3 * i + 1] = g / 255; col[3 * i + 2] = b / 255;
    }
    sceneObj.geometry.attributes.color.needsUpdate = true;
  }

  function setFrame(f) {
    const m = data.meta, Np = m.person_points, b0 = m.bbox_min, b1 = m.bbox_max;
    const pos = personObj.geometry.attributes.position.array, col = personObj.geometry.attributes.color.array;
    const base = f * Np * 3;
    for (let i = 0; i < Np; i++) {
      const q = base + 3 * i;
      const x = b0[0] + (data.personPos[q] + 32768) / 65535 * (b1[0] - b0[0]);
      const y = b0[1] + (data.personPos[q + 1] + 32768) / 65535 * (b1[1] - b0[1]);
      const z = b0[2] + (data.personPos[q + 2] + 32768) / 65535 * (b1[2] - b0[2]);
      pos[3 * i] = x; pos[3 * i + 1] = z; pos[3 * i + 2] = -y;
      if (colourMode === 'velocity') velColour(data.personVel[f * Np + i] / 127, col, 3 * i);
      else if (colourMode === 'normals') { col[3 * i] = data.personNrm[q] / 255; col[3 * i + 1] = data.personNrm[q + 1] / 255; col[3 * i + 2] = data.personNrm[q + 2] / 255; }
      else { col[3 * i] = PERSON_GREY[0] / 255; col[3 * i + 1] = PERSON_GREY[1] / 255; col[3 * i + 2] = PERSON_GREY[2] / 255; }
    }
    personObj.geometry.attributes.position.needsUpdate = true;
    personObj.geometry.attributes.color.needsUpdate = true;
    slider.value = f;
    readout.textContent = `${(f / m.fps).toFixed(1)} s  ·  frame ${m.start_frame + f}`;
  }

  // controls
  const seqChips = chips.querySelectorAll('.chip[data-seq]'), colChips = chips.querySelectorAll('.chip[data-color]');
  seqChips.forEach((c) => c.addEventListener('click', () => { seqChips.forEach((d) => d.classList.toggle('on', d === c)); load(c.dataset.seq); }));
  colChips.forEach((c) => c.addEventListener('click', () => {
    colChips.forEach((d) => d.classList.toggle('on', d === c)); colourMode = c.dataset.color;
    if (data) { colourScene(); setFrame(frame); }
  }));
  seqChips[0].classList.add('on'); colChips[0].classList.add('on');
  slider.addEventListener('input', () => { playing = false; playBtn.textContent = 'play'; frame = +slider.value; setFrame(frame); });
  playBtn.addEventListener('click', () => { playing = !playing; playBtn.textContent = playing ? 'pause' : 'play'; });
  load(seqChips[0].dataset.seq);

  function tick(now) {
    requestAnimationFrame(tick);
    const dt = (now - last) / 1000; last = now;
    if (data && playing) {
      acc += dt;
      const step = 1 / data.meta.fps;
      if (acc >= step) { acc %= step; frame = (frame + 1) % data.meta.frames; setFrame(frame); }
    }
    controls.update();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(tick);
}
