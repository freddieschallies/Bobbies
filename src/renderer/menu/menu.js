'use strict';
/* global fmt, pos */
// Bobbies POS — customer menu screen (the TV).

// The till shows a small live copy of this screen ("mirror" mode). The copy
// borrows the till's connection and follows the real TV instead of choosing
// its own videos.
const MIRROR = new URLSearchParams(location.search).has('mirror');
if (MIRROR && !window.pos) {
  try { window.pos = window.parent.pos; } catch (e) { /* not inside the till */ }
}

const $ = (id) => document.getElementById(id);
const { money, esc } = fmt;

let state = { categories: [], products: [], videos: [], settings: {} };
let lastSeen = new Map();   // productId -> "price|low" to flash changed rows

// ================================================================ menu board
// "BGF420 Clubhouse" -> green "BGF420" + white "Clubhouse"
function brandHTML(name) {
  const words = String(name || '').trim().split(/\s+/);
  if (words.length < 2) return esc(name);
  const last = words.pop();
  return `${esc(words.join(' '))} <span class="white">${esc(last)}</span>`;
}

function renderBoard() {
  $('shopName').innerHTML = brandHTML(state.settings.shopName || 'Menu');
  $('shopTag').textContent = state.settings.tagline || '';
  $('slogan').textContent = state.settings.slogan || '';
  const groups = state.categories
    .map((c, i) => ({
      color: i % 6,
      cat: c,
      items: state.products
        .filter((p) => p.categoryId === c.id && p.active && p.stock > 0)
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((g) => g.items.length);

  if (!groups.length) {
    $('board').innerHTML = '<div class="empty-board">Menu coming soon</div>';
    return;
  }

  const seen = new Map();
  $('board').innerHTML = groups.map((g) => `
    <section class="cat cat-c${g.color}">
      <h2><img src="../shared/img/leaf.svg" alt="">${esc(g.cat.name)}</h2>
      <div class="items">
      ${g.items.map((p) => {
        const low = fmt.isLow(p);
        const special = p.specialPrice !== null && p.specialPrice !== undefined && p.specialPrice < p.price;
        const key = `${p.price}|${p.specialPrice}|${low}`;
        seen.set(p.id, key);
        const changed = lastSeen.size && lastSeen.get(p.id) !== key;
        return `<div class="item ${changed ? 'changed' : ''}">
          <span class="name">${esc(p.name)}${special ? '<span class="badge special">Special</span>' : ''}${low ? '<span class="badge">Low stock</span>' : ''}</span>
          <span class="price">${special ? `<s>${money(p.price)}</s>${money(p.specialPrice)}` : money(p.price)} <span class="unit">/ ${esc(p.unit)}</span></span>
          ${p.description ? `<span class="desc">${esc(p.description)}</span>` : ''}
        </div>`;
      }).join('')}
      </div>
    </section>`).join('');
  lastSeen = seen;
  fitBoard();
}

// Spread the menu over columns, then shrink the text until it all fits the stage.
function fitBoard() {
  const board = $('board');
  const stage = $('stage');
  const aspect = stage.clientWidth / Math.max(1, stage.clientHeight);
  board.style.columnCount = aspect > 1.45 ? 3 : aspect > 0.85 ? 2 : 1;
  let size = Math.max(14, Math.round(stage.clientHeight / 27));
  board.style.fontSize = `${size}px`;
  while (size > 9 && (board.scrollWidth > board.clientWidth + 2 || board.scrollHeight > board.clientHeight + 2)) {
    size -= 1;
    board.style.fontSize = `${size}px`;
  }
}

function tickClock() {
  const now = new Date();
  $('clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('date').textContent = now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

// ================================================================ videos
// Rules:
//  * every N minutes of menu, play one random video, then back to the menu
//  * never while a sale is open on the till, and not until a short quiet
//    period after the sale is done
//  * shuffle: every video plays once before any repeats
//  * vertical / odd-shaped videos get a blurred fill — never black bars

const layer = $('videoLayer');
const vid = $('vid');
const canvas = $('blurBg');
const ctx = canvas.getContext('2d');

let saleActive = false;
let lastSaleEnd = 0;
let playing = false;
let timer = null;
let bag = [];
let lastPlayedId = null;
let drawHandle = null;

const intervalMs = () => Math.max(1, Number(state.settings.videoIntervalMin) || 5) * 60 * 1000;
const resumeMs = () => Math.max(0, Number(state.settings.resumeDelaySec) || 0) * 1000;
const enabledVideos = () => state.videos.filter((v) => v.enabled);

function scheduleNext(ms = intervalMs()) {
  clearTimeout(timer);
  timer = setTimeout(tryPlay, ms);
}

function canPlayNow() {
  return !saleActive && Date.now() - lastSaleEnd >= resumeMs();
}

function tryPlay() {
  if (playing) return;
  if (!canPlayNow()) { scheduleNext(3000); return; }   // check again shortly
  const v = nextVideo();
  if (!v) { scheduleNext(); return; }
  play(v);
}

function nextVideo() {
  const list = enabledVideos();
  if (!list.length) return null;
  bag = bag.filter((id) => list.some((v) => v.id === id));
  if (!bag.length) {
    bag = list.map((v) => v.id);
    for (let i = bag.length - 1; i > 0; i -= 1) {           // Fisher–Yates shuffle
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    if (bag.length > 1 && bag[bag.length - 1] === lastPlayedId) {
      [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
    }
  }
  const id = bag.pop();
  return list.find((v) => v.id === id);
}

// Videos play inside the stage, so shapes are measured against the stage, not the whole TV.
const stageAspect = () => $('stage').clientWidth / Math.max(1, $('stage').clientHeight);

function sizeCanvas() {
  const w = 96;
  canvas.width = w;
  canvas.height = Math.max(1, Math.round(w / stageAspect()));
}

// Draw the current frame "cover"-style into the small canvas; CSS blurs and stretches it.
function drawBlur() {
  if (!playing) return;
  const vw = vid.videoWidth;
  const vh = vid.videoHeight;
  if (vw && vh) {
    const cw = canvas.width;
    const ch = canvas.height;
    const scale = Math.max(cw / vw, ch / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    ctx.drawImage(vid, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  }
  drawHandle = vid.requestVideoFrameCallback
    ? vid.requestVideoFrameCallback(drawBlur)
    : requestAnimationFrame(drawBlur);
}

function play(v, startAt) {
  playing = true;
  lastPlayedId = v.id;
  vid.muted = MIRROR || !state.settings.videoSound;
  vid.src = pos.videoUrl(v.file);
  if (!MIRROR) pos.sendTvStatus({ playing: true, id: v.id, file: v.file, name: v.name, at: Date.now() });
  vid.onloadedmetadata = () => {
    // The mini TV joins a video already playing: jump to the same moment.
    if (startAt) {
      const offset = (Date.now() - startAt) / 1000;
      if (offset > 0 && offset < vid.duration) vid.currentTime = offset;
    }
    const screenAspect = stageAspect();
    const videoAspect = vid.videoWidth / vid.videoHeight;
    // Same shape as the stage (within 4%)? Fill edge to edge. Otherwise (vertical,
    // square, 4:3...) show the whole video on a blurred copy of itself.
    const sameShape = Math.abs(videoAspect - screenAspect) / screenAspect < 0.04;
    layer.classList.toggle('fill', sameShape);
    sizeCanvas();
  };
  vid.onplaying = () => {
    layer.classList.add('on');
    drawBlur();
  };
  vid.onended = () => stop();
  vid.onerror = () => stop();
  vid.play().catch(() => stop());
}

function stop() {
  if (!playing) return;
  playing = false;
  layer.classList.remove('on');
  if (drawHandle && vid.cancelVideoFrameCallback) vid.cancelVideoFrameCallback(drawHandle);
  setTimeout(() => {
    if (playing) return;
    vid.pause();
    vid.removeAttribute('src');
    vid.load();
  }, 650);  // let the fade finish
  if (MIRROR) return;
  pos.sendTvStatus({ playing: false });
  scheduleNext();
}

// Mirror mode: copy whatever the real TV is doing.
function followTv(s) {
  if (s && s.playing) {
    if (playing && lastPlayedId === s.id) return;
    if (playing) { playing = false; layer.classList.remove('on'); }
    play({ id: s.id, file: s.file, name: s.name }, s.at);
  } else if (playing) {
    stop();
  }
}

// ================================================================ wiring
pos.onState((s) => {
  const timingChanged = s.settings.videoIntervalMin !== state.settings.videoIntervalMin;
  state = s;
  renderBoard();
  if (MIRROR) return;
  if (playing && !enabledVideos().length) stop();
  if (timingChanged && !playing) scheduleNext();
});

if (MIRROR) pos.onTvStatus(followTv);
else pos.onSaleActive((active) => {
  const was = saleActive;
  saleActive = active;
  if (active && playing) stop();          // customer started ordering: back to the menu now
  if (was && !active) lastSaleEnd = Date.now();
});

if (!MIRROR) pos.onTestVideo(() => {
  if (playing || saleActive) return;
  const v = nextVideo();
  if (v) { clearTimeout(timer); play(v); }
});

window.addEventListener('resize', () => { fitBoard(); sizeCanvas(); });

(async function start() {
  state = await pos.getState();
  saleActive = await pos.getSaleActive();
  await document.fonts.ready;   // measure with the cartoon fonts, not the fallback
  renderBoard();
  tickClock();
  setInterval(tickClock, 1000 * 15);
  if (MIRROR) followTv(await pos.getTvStatus());
  else { pos.sendTvStatus({ playing: false }); scheduleNext(); }
})();
