'use strict';
/* global fmt, pos */
// Bobbies POS — customer menu screen (the TV).

const $ = (id) => document.getElementById(id);
const { money, esc } = fmt;

let state = { categories: [], products: [], videos: [], settings: {} };
let lastSeen = new Map();   // productId -> "price|low" to flash changed rows

// ================================================================ menu board
function renderBoard() {
  $('shopName').textContent = state.settings.shopName || 'Menu';
  const groups = state.categories
    .map((c) => ({
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
    <section class="cat">
      <h2>${esc(g.cat.name)}</h2>
      ${g.items.map((p) => {
        const low = fmt.isLow(p);
        const key = `${p.price}|${low}`;
        seen.set(p.id, key);
        const changed = lastSeen.size && lastSeen.get(p.id) !== key;
        return `<div class="item ${changed ? 'changed' : ''}">
          <span class="name">${esc(p.name)}${low ? '<span class="badge">Low stock</span>' : ''}</span>
          <span class="price">${money(p.price)} <span class="unit">/ ${esc(p.unit)}</span></span>
          ${p.description ? `<span class="desc">${esc(p.description)}</span>` : ''}
        </div>`;
      }).join('')}
    </section>`).join('');
  lastSeen = seen;
  fitBoard();
}

// Spread the menu over columns, then shrink the text until it all fits.
function fitBoard() {
  const root = document.documentElement;
  const board = $('board');
  const aspect = window.innerWidth / window.innerHeight;
  board.style.columnCount = aspect > 1.4 ? 3 : aspect > 0.9 ? 2 : 1;
  const max = Math.max(16, Math.round(window.innerHeight / 34));
  let size = max;
  root.style.fontSize = `${size}px`;
  while (size > 10 && (board.scrollWidth > board.clientWidth + 2 || board.scrollHeight > board.clientHeight + 2)) {
    size -= 1;
    root.style.fontSize = `${size}px`;
  }
}

function tickClock() {
  $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

function sizeCanvas() {
  const w = 96;
  canvas.width = w;
  canvas.height = Math.max(1, Math.round((w * window.innerHeight) / window.innerWidth));
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

function play(v) {
  playing = true;
  lastPlayedId = v.id;
  vid.muted = !state.settings.videoSound;
  vid.src = `media://v/${encodeURIComponent(v.file)}`;
  vid.onloadedmetadata = () => {
    const screenAspect = window.innerWidth / window.innerHeight;
    const videoAspect = vid.videoWidth / vid.videoHeight;
    // Same shape as the TV (within 4%)? Fill edge to edge. Otherwise (vertical,
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
  scheduleNext();
}

// ================================================================ wiring
pos.onState((s) => {
  const timingChanged = s.settings.videoIntervalMin !== state.settings.videoIntervalMin;
  state = s;
  renderBoard();
  if (playing && !enabledVideos().length) stop();
  if (timingChanged && !playing) scheduleNext();
});

pos.onSaleActive((active) => {
  const was = saleActive;
  saleActive = active;
  if (active && playing) stop();          // customer started ordering: back to the menu now
  if (was && !active) lastSaleEnd = Date.now();
});

pos.onTestVideo(() => {
  if (playing || saleActive) return;
  const v = nextVideo();
  if (v) { clearTimeout(timer); play(v); }
});

window.addEventListener('resize', () => { fitBoard(); sizeCanvas(); });

(async function start() {
  state = await pos.getState();
  saleActive = await pos.getSaleActive();
  renderBoard();
  tickClock();
  setInterval(tickClock, 1000 * 15);
  scheduleNext();
})();
