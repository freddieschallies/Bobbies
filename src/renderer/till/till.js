'use strict';
/* global fmt, pos */
// Bobbies POS — till screen.

const $ = (id) => document.getElementById(id);
const { money, esc } = fmt;

let state = { categories: [], products: [], videos: [], settings: {} };
let view = 'sell';
let panel = 'products';
let activeCat = null;
let sale = [];           // [{ productId, qty }]
let selectedLine = -1;
let highlight = 0;       // keyboard highlight in the product grid

// ---------------------------------------------------------------- helpers
async function api(method, ...args) {
  const r = await pos.call(method, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.result;
}
const product = (id) => state.products.find((p) => p.id === id);
const catName = (id) => (state.categories.find((c) => c.id === id) || {}).name || '—';
const catClass = (id) => `cat-c${Math.max(0, state.categories.findIndex((c) => c.id === id)) % 6}`;

// "BGF420 Clubhouse" -> green "BGF420" + white "Clubhouse"
function brandHTML(name) {
  const words = String(name || '').trim().split(/\s+/);
  if (words.length < 2) return esc(name);
  const last = words.pop();
  return `${esc(words.join(' '))} <span class="white">${esc(last)}</span>`;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 4000 : 2500);
}

// ---------------------------------------------------------------- modal
const modal = $('modal');
function openModal({ title, body, okText = 'OK', onOpen, onSubmit, hideCancel = false }) {
  return new Promise((resolve) => {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = body;
    $('modalError').textContent = '';
    $('modalOk').innerHTML = `${esc(okText)} <kbd>Enter</kbd>`;
    $('modalCancel').hidden = hideCancel;
    const finish = (value) => {
      $('modalForm').onsubmit = null;
      modal.oncancel = null;
      $('modalCancel').onclick = null;
      modal.close();
      resolve(value);
      focusSearch();
    };
    $('modalForm').onsubmit = async (e) => {
      e.preventDefault();
      $('modalOk').disabled = true;
      try {
        const r = onSubmit ? await onSubmit($('modalBody')) : true;
        if (r !== false) finish(r === undefined ? true : r);
      } catch (err) {
        $('modalError').textContent = err.message;
      } finally {
        $('modalOk').disabled = false;
      }
    };
    $('modalCancel').onclick = () => finish(null);
    modal.oncancel = (e) => { e.preventDefault(); finish(null); };
    modal.showModal();
    if (onOpen) onOpen($('modalBody'));
    const first = $('modalBody').querySelector('input:not([type=checkbox]):not([type=radio]), select');
    (first || $('modalOk')).focus();
    if (first && first.select) first.select();
  });
}
const confirmBox = (title, text, okText = 'Yes') =>
  openModal({ title, body: `<p>${esc(text)}</p>`, okText });

// ---------------------------------------------------------------- views
function setView(v) {
  view = v;
  $('viewToggle').innerHTML = v === 'sell' ? 'Settings <kbd>F10</kbd>' : 'Back to selling <kbd>F10</kbd>';
  $('viewToggle').classList.toggle('on', v === 'settings');
  $('view-sell').hidden = v !== 'sell';
  $('view-settings').hidden = v !== 'settings';
  if (v === 'sell') focusSearch();
  else setPanel(panel);
}

function setPanel(p) {
  panel = p;
  document.querySelectorAll('.sub-btn').forEach((b) => b.classList.toggle('active', b.dataset.panel === p));
  document.querySelectorAll('.panel').forEach((el) => { el.hidden = el.id !== `panel-${p}`; });
  if (p === 'products') renderProductRows();
  if (p === 'categories') renderCategoryRows();
  if (p === 'screen') { fillScreenSettings(); renderVideoRows(); }
  if (p === 'cashup') { if (!$('cashupDate').value) $('cashupDate').value = fmt.today(); renderCashup(); }
  if (p === 'general') fillGeneral();
}

function focusSearch() {
  if (view === 'sell' && !modal.open) $('search').focus();
}

// ---------------------------------------------------------------- sell: catalog
const SPECIALS = '__specials';
const hasSpecial = (p) => p.specialPrice !== null && p.specialPrice !== undefined && p.specialPrice < p.price;
const priceOf = (p) => (hasSpecial(p) ? p.specialPrice : p.price);

// Pick a cartoon picture for a category from its name.
function catPic(name) {
  const n = String(name).toLowerCase();
  if (/bud|flower|weed|strain|herb/.test(n)) return 'bud';
  if (/pre.?roll|joint|blunt|spliff/.test(n)) return 'prerolls';
  if (/edible|gumm|candy|sweet|brownie|cookie|choc|snack/.test(n)) return 'edibles';
  if (/oil|tinct|vape|cart|drop/.test(n)) return 'oils';
  if (/access|grind|paper|pipe|bong|lighter|merch|gear/.test(n)) return 'accessories';
  if (/special|deal|promo/.test(n)) return 'specials';
  return 'other';
}
const picUrl = (key) => `../shared/img/cats/${key}.svg`;

function visibleProducts() {
  const q = $('search').value.trim().toLowerCase();
  let list = state.products.filter((p) => p.active);
  if (q) list = list.filter((p) => p.name.toLowerCase().includes(q));
  else if (activeCat === SPECIALS) list = list.filter(hasSpecial);
  else list = list.filter((p) => p.categoryId === activeCat);
  return list.sort((a, b) => (b.stock > 0) - (a.stock > 0) || a.name.localeCompare(b.name));
}

function renderCatalog() {
  const q = $('search').value.trim();
  const home = !q && !activeCat;
  $('tileGrid').hidden = !home;
  $('productGrid').hidden = home;
  $('btnBack').hidden = home;
  const title = $('catalogTitle');
  title.hidden = home || Boolean(q);
  if (!title.hidden) {
    const special = activeCat === SPECIALS;
    title.textContent = special ? 'Specials' : catName(activeCat);
    title.className = `catalog-title ${special ? '' : catClass(activeCat)}`;
    title.style.setProperty('--cat', special ? '#ff4fa3' : '');
  }
  $('search').placeholder = home ? 'Type a product name, then Enter to add' : 'Search all products';
  if (home) renderTiles();
  else renderGrid();
}

function renderTiles() {
  const inStock = (list) => list.filter((p) => p.active && p.stock > 0).length;
  const tiles = [];
  const specials = state.products.filter((p) => p.active && hasSpecial(p));
  if (specials.length) {
    tiles.push(`<button class="tile specials" data-cat="${SPECIALS}">
      <span class="t-count">${inStock(specials)} deals</span>
      <img src="${picUrl('specials')}" alt="">
      <span class="t-name">Specials</span><span class="t-go">›</span></button>`);
  }
  state.categories.forEach((c) => {
    const n = inStock(state.products.filter((p) => p.categoryId === c.id));
    tiles.push(`<button class="tile ${catClass(c.id)}" data-cat="${c.id}">
      <span class="t-count">${n} item${n === 1 ? '' : 's'}</span>
      <img src="${picUrl(catPic(c.name))}" alt="">
      <span class="t-name">${esc(c.name)}</span><span class="t-go">›</span></button>`);
  });
  $('tileGrid').innerHTML = tiles.join('') || '<div class="empty">Add categories under Settings → Categories.</div>';
}

function renderGrid() {
  const list = visibleProducts();
  const sellable = list.filter((p) => p.stock > 0);
  if (highlight >= sellable.length) highlight = Math.max(0, sellable.length - 1);
  const hiId = $('search').value.trim() && sellable[highlight] ? sellable[highlight].id : null;
  if (!list.length) {
    $('productGrid').innerHTML = `<div class="empty">${$('search').value.trim()
      ? 'No products match.'
      : 'Nothing here yet. Add products under Settings → Products &amp; stock.'}</div>`;
    return;
  }
  $('productGrid').innerHTML = list.map((p) => {
    const low = fmt.isLow(p);
    const out = p.stock <= 0;
    const pic = picUrl(catPic(catName(p.categoryId)));
    const priceHTML = hasSpecial(p)
      ? `<s>${money(p.price)}</s>${money(p.specialPrice)} / ${esc(p.unit)}`
      : esc(fmt.perUnit(p));
    return `<button class="product ${catClass(p.categoryId)} ${out ? 'out' : ''} ${p.id === hiId ? 'highlight' : ''}" style="--pic:url('${pic}')" data-id="${p.id}" ${out ? 'disabled' : ''}>
      ${hasSpecial(p) ? '<span class="deal">Special</span>' : ''}
      <span class="p-name">${esc(p.name)}</span>
      <span class="p-price">${priceHTML}</span>
      <span class="p-stock ${low ? 'low' : ''}">${out ? 'Out of stock' : `${esc(fmt.qty(p.stock, p.unit))} left${low ? ' · low' : ''}`}</span>
    </button>`;
  }).join('');
  const hi = $('productGrid').querySelector('.highlight');
  if (hi) hi.scrollIntoView({ block: 'nearest' });
}

function openCategory(id) {
  activeCat = id;
  $('search').value = '';
  highlight = 0;
  renderCatalog();
  focusSearch();
}

function goHome() {
  activeCat = null;
  $('search').value = '';
  highlight = 0;
  renderCatalog();
  focusSearch();
}

// ---------------------------------------------------------------- sell: sale
function inSale(productId) {
  return sale.filter((l) => l.productId === productId).reduce((s, l) => s + l.qty, 0);
}

function lineTotal(l) {
  const p = product(l.productId);
  return p ? Math.round(priceOf(p) * l.qty) : 0;
}
function lineFull(l) {
  const p = product(l.productId);
  return p ? Math.round(p.price * l.qty) : 0;
}

function saleChanged() {
  sale = sale.filter((l) => product(l.productId) && l.qty > 0);
  if (selectedLine >= sale.length) selectedLine = sale.length - 1;
  pos.setSaleActive(sale.length > 0);
  renderSale();
  renderCatalog();
}

function renderSale() {
  $('saleLines').innerHTML = sale.map((l, i) => {
    const p = product(l.productId);
    const each = hasSpecial(p) ? `${money(p.specialPrice)} each · special` : `${money(p.price)} each`;
    return `<li class="sale-line ${i === selectedLine ? 'selected' : ''}" data-i="${i}">
      <span class="l-name">${esc(p.name)}<small>${each}<button class="l-remove" data-remove="${i}" title="Remove">✕</button></small></span>
      <span class="l-qty">${esc(fmt.qty(l.qty, p.unit))}</span>
      <span class="l-total">${money(lineTotal(l))}</span>
    </li>`;
  }).join('') || '<li class="empty">Nothing on the sale yet.</li>';
  const total = sale.reduce((s, l) => s + lineTotal(l), 0);
  const full = sale.reduce((s, l) => s + lineFull(l), 0);
  $('saleSubtotal').textContent = money(full);
  $('saleDiscount').textContent = full > total ? `− ${money(full - total)}` : money(0);
  $('saleTotal').textContent = money(total);
  $('btnCash').disabled = $('btnCard').disabled = sale.length === 0;
  const sel = $('saleLines').querySelector('.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

async function askQty(p, current) {
  const already = inSale(p.id) - (current || 0);
  const max = Math.round((p.stock - already) * 100) / 100;
  return openModal({
    title: p.name,
    okText: current ? 'Update' : 'Add',
    body: `<div class="form">
      <label>How many ${esc(p.unit)}? <small>(${esc(fmt.qty(max, p.unit))} available)</small>
        <input id="qtyIn" class="input big" inputmode="decimal" value="${current || ''}"></label>
      <div id="qtyPrice" class="change">&nbsp;</div></div>`,
    onOpen: (b) => {
      const inp = b.querySelector('#qtyIn');
      const upd = () => {
        const q = fmt.num(inp.value);
        b.querySelector('#qtyPrice').innerHTML = q > 0 ? `= <strong>${money(Math.round(priceOf(p) * q))}</strong>` : '&nbsp;';
      };
      inp.addEventListener('input', upd);
      upd();
    },
    onSubmit: (b) => {
      const q = Math.round(fmt.num(b.querySelector('#qtyIn').value) * 100) / 100;
      if (!(q > 0)) throw new Error('Enter an amount.');
      if (!p.weighed && !Number.isInteger(q)) throw new Error(`${p.name} is sold in whole ${p.unit}s.`);
      if (q > max) throw new Error(`Only ${fmt.qty(max, p.unit)} available.`);
      return q;
    },
  });
}

async function addToSale(p) {
  if (!p || p.stock <= 0) { toast(`${p ? p.name : 'That'} is out of stock.`, true); return; }
  let qty = 1;
  if (p.weighed) {
    qty = await askQty(p);
    if (!qty) return;
  } else if (inSale(p.id) + 1 > p.stock) {
    toast(`Only ${fmt.qty(p.stock, p.unit)} of ${p.name} in stock.`, true);
    return;
  }
  const idx = sale.findIndex((l) => l.productId === p.id);
  if (idx >= 0) {
    sale[idx].qty = Math.round((sale[idx].qty + qty) * 100) / 100;
    selectedLine = idx;
  } else {
    sale.push({ productId: p.id, qty });
    selectedLine = sale.length - 1;
  }
  $('search').value = '';
  highlight = 0;
  saleChanged();
  focusSearch();
}

function bumpLine(delta) {
  const l = sale[selectedLine];
  if (!l) return;
  const p = product(l.productId);
  const next = Math.round((l.qty + delta) * 100) / 100;
  if (next > p.stock) { toast(`Only ${fmt.qty(p.stock, p.unit)} in stock.`, true); return; }
  l.qty = next;
  saleChanged();
}

async function editLine(i) {
  const l = sale[i];
  if (!l) return;
  selectedLine = i;
  renderSale();
  const q = await askQty(product(l.productId), l.qty);
  if (q) { l.qty = q; saleChanged(); }
}

function removeLine(i) {
  sale.splice(i, 1);
  if (selectedLine >= sale.length) selectedLine = sale.length - 1;
  saleChanged();
}

async function clearSale() {
  if (!sale.length) return;
  if (await confirmBox('Clear sale?', 'Remove everything from this sale?', 'Clear sale')) {
    sale = [];
    selectedLine = -1;
    saleChanged();
  }
}

function finishSale(done) {
  sale = [];
  selectedLine = -1;
  saleChanged();
  $('lastSale').innerHTML = done.method === 'cash'
    ? `Sale #${done.no} done · Cash · Change: ${money(done.change)}`
    : `Sale #${done.no} done · Card · ${money(done.total)}`;
  toast(`Sale #${done.no} saved`);
}

async function payCash() {
  if (!sale.length) return;
  const total = sale.reduce((s, l) => s + lineTotal(l), 0);
  const quick = [...new Set([total, ...[5000, 10000, 20000].map((n) => Math.ceil(total / n) * n)])]
    .filter((v) => v >= total).sort((a, b) => a - b).slice(0, 4);
  const done = await openModal({
    title: 'Cash payment',
    okText: 'Complete sale',
    body: `<p class="big-total">${money(total)}</p>
      <div class="form"><label>Cash given
        <input id="tendered" class="input big" inputmode="decimal" placeholder="${(total / 100).toFixed(2)}"></label></div>
      <div class="quick-cash">${quick.map((v, i) =>
        `<button type="button" class="btn-ghost btn-sm" data-v="${v}">${i === 0 ? 'Exact' : money(v)}</button>`).join('')}</div>
      <div id="changeOut" class="change">Change: <strong>—</strong></div>`,
    onOpen: (b) => {
      const inp = b.querySelector('#tendered');
      const upd = () => {
        const t = inp.value.trim() === '' ? total : fmt.toCents(inp.value);
        const out = b.querySelector('#changeOut');
        out.classList.toggle('short', !(t >= total));
        out.innerHTML = t >= total ? `Change: <strong>${money(t - total)}</strong>` : `Short: <strong>${money(total - (t || 0))}</strong>`;
      };
      inp.addEventListener('input', upd);
      b.querySelectorAll('[data-v]').forEach((btn) => btn.addEventListener('click', () => {
        inp.value = (Number(btn.dataset.v) / 100).toFixed(2);
        upd();
        inp.focus();
      }));
      upd();
    },
    onSubmit: async (b) => {
      const raw = b.querySelector('#tendered').value.trim();
      const tendered = raw === '' ? total : fmt.toCents(raw);   // empty = exact money
      return api('completeSale', { lines: sale, method: 'cash', tendered });
    },
  });
  if (done) finishSale(done);
}

async function payCard() {
  if (!sale.length) return;
  const total = sale.reduce((s, l) => s + lineTotal(l), 0);
  const done = await openModal({
    title: 'Card payment',
    okText: 'Approved — complete sale',
    body: `<p class="big-total">${money(total)}</p>
      <p>Put this amount through on the card machine. Press <kbd>Enter</kbd> once it shows <b>approved</b>.</p>`,
    onSubmit: () => api('completeSale', { lines: sale, method: 'card' }),
  });
  if (done) finishSale(done);
}

// ---------------------------------------------------------------- settings: products
function renderProductRows() {
  const q = $('productFilter').value.trim().toLowerCase();
  const order = new Map(state.categories.map((c) => [c.id, c.order]));
  const list = state.products
    .filter((p) => !q || p.name.toLowerCase().includes(q) || catName(p.categoryId).toLowerCase().includes(q))
    .sort((a, b) => (order.get(a.categoryId) - order.get(b.categoryId)) || a.name.localeCompare(b.name));
  $('productRows').innerHTML = list.map((p) => {
    const tag = p.stock <= 0 ? '<span class="tag out">Out</span>' : fmt.isLow(p) ? '<span class="tag low">Low</span>' : '';
    return `<tr>
      <td><strong>${esc(p.name)}</strong></td>
      <td>${esc(catName(p.categoryId))}</td>
      <td>${hasSpecial(p) ? `<s>${money(p.price)}</s> ${money(p.specialPrice)} / ${esc(p.unit)} <span class="tag special">Special</span>` : esc(fmt.perUnit(p))}</td>
      <td>${esc(fmt.qty(p.stock, p.unit))} ${tag}</td>
      <td>${esc(fmt.qty(p.lowStock, p.unit))}</td>
      <td>${p.active ? 'Yes' : 'Hidden'}</td>
      <td class="actions">
        <button class="btn-ghost btn-sm" data-act="stock" data-id="${p.id}">Stock</button>
        <button class="btn-ghost btn-sm" data-act="edit" data-id="${p.id}">Edit</button>
        <button class="btn-danger btn-sm" data-act="del" data-id="${p.id}">Delete</button>
      </td></tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">No products yet. Click “+ Add product”.</td></tr>';
}

async function productForm(p) {
  if (!state.categories.length) { toast('Add a category first.', true); return; }
  const isNew = !p;
  const startCat = activeCat && activeCat !== SPECIALS ? activeCat : state.categories[0].id;
  p = p || { name: '', categoryId: startCat, specialPrice: null, unit: 'g', weighed: true, price: 0, lowStock: 5, stock: 0, active: true, description: '' };
  await openModal({
    title: isNew ? 'Add product' : `Edit ${p.name}`,
    okText: 'Save',
    body: `<div class="form">
      <label>Name <input name="name" class="input" value="${esc(p.name)}"></label>
      <div class="row">
        <label>Category <select name="categoryId" class="input">${state.categories.map((c) =>
          `<option value="${c.id}" ${c.id === p.categoryId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label>Sold per <input name="unit" class="input" list="unitList" value="${esc(p.unit)}"></label>
      </div>
      <datalist id="unitList"><option value="g"><option value="joint"><option value="piece"><option value="pack"><option value="bottle"><option value="ml"></datalist>
      <label class="check"><input name="weighed" type="checkbox" ${p.weighed ? 'checked' : ''}> Sold by weight (ask for grams at the till)</label>
      <div class="row">
        <label>Price per unit (R) <input name="price" class="input" inputmode="decimal" value="${(p.price / 100).toFixed(2)}"></label>
        <label>Special price (R) — leave empty for none <input name="specialPrice" class="input" inputmode="decimal" value="${hasSpecial(p) ? (p.specialPrice / 100).toFixed(2) : ''}" placeholder="No special"></label>
      </div>
      <label>Show “low stock” at <input name="lowStock" class="input" inputmode="decimal" value="${p.lowStock}"></label>
      ${isNew ? `<label>Opening stock <input name="stock" class="input" inputmode="decimal" value="0"></label>` : ''}
      <label>Short description for the menu (optional) <input name="description" class="input" value="${esc(p.description || '')}"></label>
      <label class="check"><input name="active" type="checkbox" ${p.active ? 'checked' : ''}> Show on the menu and till</label>
    </div>`,
    onOpen: (b) => {
      const unit = b.querySelector('[name=unit]');
      unit.addEventListener('input', () => {
        b.querySelector('[name=weighed]').checked = /^(g|gram|grams|ml)$/i.test(unit.value.trim());
      });
    },
    onSubmit: (b) => {
      const v = (n) => b.querySelector(`[name=${n}]`);
      const price = fmt.toCents(v('price').value);
      if (!Number.isFinite(price)) throw new Error('Enter a valid price.');
      const specialRaw = v('specialPrice').value.trim();
      const specialPrice = specialRaw === '' ? null : fmt.toCents(specialRaw);
      if (specialRaw !== '' && !Number.isFinite(specialPrice)) throw new Error('Enter a valid special price, or leave it empty.');
      const lowStock = fmt.num(v('lowStock').value || 0);
      if (!Number.isFinite(lowStock)) throw new Error('Enter a valid low-stock level.');
      const data = {
        id: isNew ? undefined : p.id,
        name: v('name').value,
        categoryId: v('categoryId').value,
        unit: v('unit').value,
        weighed: v('weighed').checked,
        price,
        specialPrice,
        lowStock,
        active: v('active').checked,
        description: v('description').value,
      };
      if (isNew) {
        data.stock = fmt.num(v('stock').value || 0);
        if (!Number.isFinite(data.stock)) throw new Error('Enter a valid opening stock.');
      }
      return api('saveProduct', data);
    },
  });
}

async function stockForm(p) {
  const r = await openModal({
    title: `Stock — ${p.name}`,
    okText: 'Save',
    body: `<p>In stock now: <strong>${esc(fmt.qty(p.stock, p.unit))}</strong></p>
      <div class="form">
        <label class="check"><input type="radio" name="mode" value="add" checked> Stock received (adds to what's there)</label>
        <label class="check"><input type="radio" name="mode" value="set"> Counted stock (replaces the number)</label>
        <label>Amount (${esc(p.unit)}) <input name="amount" class="input big" inputmode="decimal"></label>
      </div>`,
    onSubmit: (b) => {
      const mode = b.querySelector('[name=mode]:checked').value;
      const amount = fmt.num(b.querySelector('[name=amount]').value);
      if (!Number.isFinite(amount)) throw new Error('Enter an amount.');
      return mode === 'add' ? api('adjustStock', p.id, amount, 'Stock received') : api('setStock', p.id, amount);
    },
  });
  if (r) toast(`${p.name}: ${fmt.qty(r.stock, r.unit)} in stock`);
}

// ---------------------------------------------------------------- settings: categories
function renderCategoryRows() {
  $('categoryRows').innerHTML = state.categories.map((c, i) => {
    const n = state.products.filter((p) => p.categoryId === c.id).length;
    return `<li>
      <input class="input" data-rename="${c.id}" value="${esc(c.name)}">
      <span class="cat-count">${n} product${n === 1 ? '' : 's'}</span>
      <button class="btn-ghost btn-sm" data-move="${c.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn-ghost btn-sm" data-move="${c.id}" data-dir="1" ${i === state.categories.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="btn-danger btn-sm" data-delcat="${c.id}">Delete</button>
    </li>`;
  }).join('');
}

// ---------------------------------------------------------------- settings: screen & videos
function fillScreenSettings() {
  const s = state.settings;
  $('setInterval').value = s.videoIntervalMin;
  $('setResume').value = s.resumeDelaySec;
  $('setSound').checked = s.videoSound;
}

function renderVideoRows() {
  $('videoRows').innerHTML = state.videos.map((v) => `<tr>
      <td>${esc(v.name)}</td>
      <td>${new Date(v.addedAt).toLocaleDateString()}</td>
      <td><label class="check"><input type="checkbox" data-vid="${v.id}" ${v.enabled ? 'checked' : ''}> ${v.enabled ? 'Yes' : 'Paused'}</label></td>
      <td class="actions"><button class="btn-danger btn-sm" data-delvid="${v.id}">Remove</button></td>
    </tr>`).join('') || '<tr><td colspan="4" class="empty">No videos yet. Click “+ Upload videos”.</td></tr>';
}

// ---------------------------------------------------------------- settings: cash-up
async function renderCashup() {
  const date = $('cashupDate').value || fmt.today();
  try {
    const r = await api('report', date);
    $('cashupBody').innerHTML = `
      <h2>Cash-up for ${esc(new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}</h2>
      <div class="stats">
        <div class="stat"><span>Total takings</span><strong>${money(r.total)}</strong></div>
        <div class="stat"><span>Cash (${r.byMethod.cash.count} sales)</span><strong>${money(r.byMethod.cash.total)}</strong></div>
        <div class="stat"><span>Card (${r.byMethod.card.count} sales)</span><strong>${money(r.byMethod.card.total)}</strong></div>
        <div class="stat"><span>Number of sales</span><strong>${r.count}</strong></div>
        <div class="stat"><span>Specials discount given</span><strong>${money(r.discount || 0)}</strong></div>
      </div>
      <h3>Sold today</h3>
      <table class="table"><thead><tr><th>Product</th><th>Amount</th><th>Takings</th></tr></thead><tbody>
        ${r.items.map((it) => `<tr><td>${esc(it.name)}</td><td>${esc(fmt.qty(it.qty, it.unit))}</td><td>${money(it.total)}</td></tr>`).join('')
          || '<tr><td colspan="3" class="empty">No sales on this day.</td></tr>'}
      </tbody></table>
      <h3>Sales</h3>
      <table class="table"><thead><tr><th>#</th><th>Time</th><th>Paid by</th><th>Total</th></tr></thead><tbody>
        ${r.sales.map((s) => `<tr><td>${s.no}</td><td>${new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td><td>${s.method === 'cash' ? 'Cash' : 'Card'}</td><td>${money(s.total)}</td></tr>`).join('')
          || '<tr><td colspan="4" class="empty">—</td></tr>'}
      </tbody></table>`;
  } catch (err) {
    $('cashupBody').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// ---------------------------------------------------------------- settings: general
function fillGeneral() {
  $('setShopName').value = state.settings.shopName;
  $('setTagline').value = state.settings.tagline || '';
  $('setSlogan').value = state.settings.slogan || '';
  $('setAutoStart').checked = state.settings.autoStart;
}

// ---------------------------------------------------------------- state
function applyState(s) {
  state = s;
  if (activeCat && activeCat !== SPECIALS && !state.categories.some((c) => c.id === activeCat)) activeCat = null;
  if (activeCat === SPECIALS && !state.products.some(hasSpecial)) activeCat = null;
  $('shopName').innerHTML = brandHTML(state.settings.shopName);
  $('shopTag').textContent = state.settings.tagline || '';
  document.title = `${state.settings.shopName} POS`;
  saleChanged();
  if (view === 'settings') {
    if (panel === 'products') renderProductRows();
    if (panel === 'categories') renderCategoryRows();
    if (panel === 'screen') renderVideoRows();
  }
}

// ---------------------------------------------------------------- events
function wire() {
  $('viewToggle').addEventListener('click', () => setView(view === 'sell' ? 'settings' : 'sell'));
  document.querySelectorAll('.sub-btn').forEach((b) => b.addEventListener('click', () => setPanel(b.dataset.panel)));

  // catalog
  $('tileGrid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (b) openCategory(b.dataset.cat);
  });
  $('btnBack').addEventListener('click', goHome);
  $('productGrid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (b) addToSale(product(b.dataset.id));
  });
  $('search').addEventListener('input', () => { highlight = 0; renderCatalog(); });
  $('search').addEventListener('keydown', (e) => {
    const q = $('search').value.trim();
    if (e.key === 'Backspace' && $('search').value === '' && activeCat) { e.preventDefault(); goHome(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const sellable = visibleProducts().filter((p) => p.stock > 0);
      if (q && sellable[highlight]) addToSale(sellable[highlight]);
      else if (q) toast('No product matches that.', true);
    } else if (q && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const n = visibleProducts().filter((p) => p.stock > 0).length;
      if (n) highlight = (highlight + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      renderGrid();
    }
  });

  // sale
  $('saleLines').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) { e.stopPropagation(); removeLine(Number(rm.dataset.remove)); return; }
    const li = e.target.closest('[data-i]');
    if (li) editLine(Number(li.dataset.i));
  });
  $('btnCash').addEventListener('click', payCash);
  $('btnCard').addEventListener('click', payCard);
  $('btnClear').addEventListener('click', clearSale);

  // products
  $('btnAddProduct').addEventListener('click', () => productForm());
  $('productFilter').addEventListener('input', renderProductRows);
  $('productRows').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const p = product(b.dataset.id);
    if (b.dataset.act === 'edit') productForm(p);
    if (b.dataset.act === 'stock') stockForm(p);
    if (b.dataset.act === 'del' && await confirmBox('Delete product?', `Delete ${p.name}? Past sales stay in the cash-up.`, 'Delete')) {
      try { await api('deleteProduct', p.id); toast(`${p.name} deleted`); } catch (err) { toast(err.message, true); }
    }
  });

  // categories
  const addCat = async () => {
    try { await api('addCategory', $('newCategory').value); $('newCategory').value = ''; } catch (err) { toast(err.message, true); }
  };
  $('btnAddCategory').addEventListener('click', addCat);
  $('newCategory').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCat(); });
  $('categoryRows').addEventListener('change', async (e) => {
    const id = e.target.dataset.rename;
    if (!id) return;
    try { await api('renameCategory', id, e.target.value); toast('Category renamed'); } catch (err) { toast(err.message, true); renderCategoryRows(); }
  });
  $('categoryRows').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset.rename) e.target.blur(); });
  $('categoryRows').addEventListener('click', async (e) => {
    const mv = e.target.closest('[data-move]');
    if (mv) { await api('moveCategory', mv.dataset.move, Number(mv.dataset.dir)); return; }
    const del = e.target.closest('[data-delcat]');
    if (del && await confirmBox('Delete category?', `Delete “${catName(del.dataset.delcat)}”?`, 'Delete')) {
      try { await api('deleteCategory', del.dataset.delcat); } catch (err) { toast(err.message, true); }
    }
  });

  // screen & videos
  $('btnSaveScreen').addEventListener('click', async () => {
    try {
      await api('updateSettings', {
        videoIntervalMin: Number($('setInterval').value),
        resumeDelaySec: Number($('setResume').value),
        videoSound: $('setSound').checked,
      });
      fillScreenSettings();
      toast('Saved');
    } catch (err) { toast(err.message, true); }
  });
  $('btnAddVideos').addEventListener('click', async () => {
    const r = await pos.addVideos();
    if (r.ok && r.result.length) toast(`${r.result.length} video${r.result.length === 1 ? '' : 's'} added`);
  });
  $('videoRows').addEventListener('change', async (e) => {
    if (e.target.dataset.vid) await api('setVideoEnabled', e.target.dataset.vid, e.target.checked);
  });
  $('videoRows').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-delvid]');
    if (b && await confirmBox('Remove video?', 'Remove this video from the menu screen?', 'Remove')) {
      const r = await pos.removeVideo(b.dataset.delvid);
      if (!r.ok) toast(r.error, true);
    }
  });
  $('btnTestVideo').addEventListener('click', () => {
    if (!state.videos.some((v) => v.enabled)) { toast('Upload a video first.', true); return; }
    pos.testVideo();
  });
  $('btnPlaceMenu').addEventListener('click', async () => {
    const r = await pos.placeMenu();
    $('screenNote').textContent = r.hasSecond
      ? 'Menu is full screen on the TV.'
      : 'No second screen found — check the HDMI extender and that Windows is set to “Extend these displays”.';
  });
  $('btnReloadMenu').addEventListener('click', () => pos.reloadMenu());

  // cash-up & general
  $('cashupDate').addEventListener('change', renderCashup);
  $('btnPrintCashup').addEventListener('click', () => window.print());
  $('btnSaveGeneral').addEventListener('click', async () => {
    try {
      await api('updateSettings', {
        shopName: $('setShopName').value,
        tagline: $('setTagline').value,
        slogan: $('setSlogan').value,
        autoStart: $('setAutoStart').checked,
      });
      toast('Saved');
    } catch (err) { toast(err.message, true); }
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (modal.open) return;
    if (e.key === 'F10') { e.preventDefault(); setView(view === 'sell' ? 'settings' : 'sell'); return; }
    if (view !== 'sell') return;
    const inSearch = document.activeElement === $('search');
    const searchEmpty = $('search').value === '';
    if (e.key === 'F1') { e.preventDefault(); payCash(); return; }
    if (e.key === 'F2') { e.preventDefault(); payCard(); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!searchEmpty) { $('search').value = ''; highlight = 0; renderCatalog(); } else clearSale();
      return;
    }
    if (searchEmpty && sale.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        selectedLine = Math.min(sale.length - 1, Math.max(0, selectedLine + (e.key === 'ArrowDown' ? 1 : -1)));
        renderSale();
        return;
      }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); bumpLine(1); return; }
      if (e.key === '-') { e.preventDefault(); bumpLine(-1); return; }
      if (e.key === 'Delete') { e.preventDefault(); removeLine(selectedLine); return; }
    }
    // Typing anywhere goes into the search box.
    if (!inSearch && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) focusSearch();
  });

  const tick = () => {
    const now = new Date();
    $('clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('date').textContent = now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  };
  tick();
  setInterval(tick, 1000);
}

// ---------------------------------------------------------------- mini TV
// A small live copy of the TV: the menu page in "mirror" mode. It follows the
// real TV (same menu, same video at the same moment) but never plays on its own.
function mountMiniTv() {
  const W = 1600;
  const H = 900;
  const box = $('tvFrame');
  const f = document.createElement('iframe');
  f.src = '../menu/index.html?mirror=1';
  f.title = 'What the TV is showing';
  f.tabIndex = -1;
  f.width = W;
  f.height = H;
  f.style.width = `${W}px`;
  f.style.height = `${H}px`;
  box.appendChild(f);
  const fit = () => { f.style.transform = `scale(${box.clientWidth / W})`; };
  new ResizeObserver(fit).observe(box);
  fit();
  const label = (s) => {
    $('tvLabel').textContent = s && s.playing ? `On the TV now: ${String(s.name || 'video').replace(/\.[a-z0-9]+$/i, '')}` : 'On the TV now: menu';
  };
  pos.onTvStatus(label);
  pos.getTvStatus().then(label);
}

// ---------------------------------------------------------------- start
(async function start() {
  wire();
  mountMiniTv();
  pos.onState(applyState);
  applyState(await pos.getState());
  pos.setSaleActive(false);
  setView('sell');
})();
