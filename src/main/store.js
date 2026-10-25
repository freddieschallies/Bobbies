'use strict';
// Bobbies POS — data store.
// Everything lives in one JSON file. Money is stored in cents (integers) so
// totals never pick up rounding errors. Stock for weighed items is in grams.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const newId = () => crypto.randomUUID();
const round2 = (n) => Math.round(Number(n) * 100) / 100;

const DEFAULT_CATEGORIES = ['Bud', 'Pre-rolls', 'Edibles', 'Oils', 'Accessories'];

function defaultData() {
  return {
    version: 1,
    categories: DEFAULT_CATEGORIES.map((name, i) => ({ id: newId(), name, order: i })),
    products: [],
    sales: [],
    stockLog: [],
    videos: [],
    settings: {
      shopName: 'BGF420 Clubhouse',
      tagline: 'Come chill with us · Est. 2023',
      slogan: 'Island party vibe · Richards Bay',
      videoIntervalMin: 5,   // minutes of menu between videos
      resumeDelaySec: 20,    // quiet time after a sale before videos may play again
      videoSound: false,
      autoStart: true,
      nextSaleNo: 1,
    },
  };
}

class StoreError extends Error {}

class Store {
  constructor(file) {
    this.file = file;
    this.data = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const base = defaultData();
      return { ...base, ...parsed, settings: { ...base.settings, ...(parsed.settings || {}) } };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep a copy of an unreadable file rather than silently overwriting it.
        try { fs.copyFileSync(this.file, `${this.file}.broken-${Date.now()}`); } catch (_) { /* ignore */ }
      }
      const data = defaultData();
      this._write(data);
      return data;
    }
  }

  _write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file); // atomic replace, so a power cut can't half-write the file
  }

  save() { this._write(this.data); }

  // ---------- public snapshot sent to the screens ----------
  publicState() {
    const { categories, products, videos, settings } = this.data;
    return {
      categories: [...categories].sort((a, b) => a.order - b.order),
      products,
      videos,
      settings,
    };
  }

  // ---------- categories ----------
  addCategory(name) {
    name = String(name || '').trim();
    if (!name) throw new StoreError('Category needs a name.');
    if (this.data.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      throw new StoreError(`There is already a category called "${name}".`);
    }
    const order = this.data.categories.reduce((m, c) => Math.max(m, c.order), -1) + 1;
    const cat = { id: newId(), name, order };
    this.data.categories.push(cat);
    this.save();
    return cat;
  }

  renameCategory(id, name) {
    name = String(name || '').trim();
    if (!name) throw new StoreError('Category needs a name.');
    const cat = this._cat(id);
    cat.name = name;
    this.save();
    return cat;
  }

  moveCategory(id, direction) {
    const cats = [...this.data.categories].sort((a, b) => a.order - b.order);
    const i = cats.findIndex((c) => c.id === id);
    const j = i + (direction < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= cats.length) return;
    [cats[i], cats[j]] = [cats[j], cats[i]];
    cats.forEach((c, k) => { c.order = k; });
    this.save();
  }

  deleteCategory(id) {
    this._cat(id);
    if (this.data.products.some((p) => p.categoryId === id)) {
      throw new StoreError('Move or delete the products in this category first.');
    }
    this.data.categories = this.data.categories.filter((c) => c.id !== id);
    this.save();
  }

  _cat(id) {
    const cat = this.data.categories.find((c) => c.id === id);
    if (!cat) throw new StoreError('Category not found.');
    return cat;
  }

  // ---------- products ----------
  saveProduct(input) {
    const name = String(input.name || '').trim();
    if (!name) throw new StoreError('Product needs a name.');
    this._cat(input.categoryId);
    const unit = String(input.unit || '').trim() || 'piece';
    const weighed = Boolean(input.weighed);
    const price = Math.round(Number(input.price));
    if (!Number.isFinite(price) || price < 0) throw new StoreError('Enter a valid price.');
    const lowStock = round2(input.lowStock || 0);
    if (lowStock < 0) throw new StoreError('Low-stock level cannot be negative.');
    // Specials: an optional lower price. Empty means no special.
    let specialPrice = null;
    if (input.specialPrice !== null && input.specialPrice !== undefined && input.specialPrice !== '') {
      specialPrice = Math.round(Number(input.specialPrice));
      if (!Number.isFinite(specialPrice) || specialPrice < 0) throw new StoreError('Enter a valid special price.');
      if (specialPrice >= price) throw new StoreError('The special price must be lower than the normal price.');
    }

    let product = input.id ? this.data.products.find((p) => p.id === input.id) : null;
    if (input.id && !product) throw new StoreError('Product not found.');
    if (!product) {
      const stock = round2(input.stock || 0);
      if (stock < 0) throw new StoreError('Stock cannot be negative.');
      product = { id: newId(), stock: 0, createdAt: new Date().toISOString() };
      this.data.products.push(product);
      if (stock) this._logStock(product, stock, 'Opening stock');
      product.stock = stock;
    }
    Object.assign(product, {
      name,
      categoryId: input.categoryId,
      unit,
      weighed,
      price,
      specialPrice,
      lowStock,
      active: input.active !== false,
      description: String(input.description || '').trim(),
    });
    this.save();
    return product;
  }

  deleteProduct(id) {
    this._product(id);
    this.data.products = this.data.products.filter((p) => p.id !== id);
    this.save();
  }

  adjustStock(id, delta, reason) {
    const p = this._product(id);
    delta = round2(delta);
    if (!delta) throw new StoreError('Enter an amount.');
    const next = round2(p.stock + delta);
    if (next < 0) throw new StoreError(`Only ${p.stock} ${p.unit} in stock.`);
    p.stock = next;
    this._logStock(p, delta, reason || (delta > 0 ? 'Stock received' : 'Stock removed'));
    this.save();
    return p;
  }

  setStock(id, count) {
    const p = this._product(id);
    count = round2(count);
    if (count < 0) throw new StoreError('Stock cannot be negative.');
    const delta = round2(count - p.stock);
    p.stock = count;
    if (delta) this._logStock(p, delta, 'Stock count');
    this.save();
    return p;
  }

  _logStock(p, delta, reason) {
    this.data.stockLog.push({ at: new Date().toISOString(), productId: p.id, name: p.name, delta, reason });
  }

  _product(id) {
    const p = this.data.products.find((x) => x.id === id);
    if (!p) throw new StoreError('Product not found.');
    return p;
  }

  // ---------- sales ----------
  // lines: [{ productId, qty }]. Prices are always taken from the store, never the screen.
  completeSale({ lines, method, tendered }) {
    if (!Array.isArray(lines) || !lines.length) throw new StoreError('The sale is empty.');
    if (method !== 'cash' && method !== 'card') throw new StoreError('Choose cash or card.');

    // Merge duplicate lines and check stock before touching anything.
    const merged = new Map();
    for (const l of lines) {
      const qty = round2(l.qty);
      if (!(qty > 0)) throw new StoreError('Quantities must be more than zero.');
      merged.set(l.productId, round2((merged.get(l.productId) || 0) + qty));
    }
    const saleLines = [];
    for (const [productId, qty] of merged) {
      const p = this._product(productId);
      if (!p.weighed && !Number.isInteger(qty)) throw new StoreError(`${p.name} is sold in whole units.`);
      if (qty > p.stock) throw new StoreError(`Not enough ${p.name} — only ${p.stock} ${p.unit} left.`);
      const price = effectivePrice(p);
      const full = Math.round(p.price * qty);
      const total = Math.round(price * qty);
      saleLines.push({ productId, name: p.name, unit: p.unit, qty, price, fullPrice: p.price, discount: full - total, total });
    }
    const total = saleLines.reduce((s, l) => s + l.total, 0);
    const discount = saleLines.reduce((s, l) => s + l.discount, 0);

    let change = 0;
    let paid = total;
    if (method === 'cash') {
      paid = Math.round(Number(tendered));
      if (!Number.isFinite(paid) || paid < total) throw new StoreError('Cash given is less than the total.');
      change = paid - total;
    }

    for (const l of saleLines) {
      const p = this._product(l.productId);
      p.stock = round2(p.stock - l.qty);
      this._logStock(p, -l.qty, 'Sale');
    }
    const sale = {
      id: newId(),
      no: this.data.settings.nextSaleNo++,
      at: new Date().toISOString(),
      method,
      lines: saleLines,
      subtotal: total + discount,
      discount,
      total,
      paid,
      change,
    };
    this.data.sales.push(sale);
    this.save();
    return sale;
  }

  // Cash-up for one day (local date string YYYY-MM-DD).
  report(dateStr) {
    const sales = this.data.sales.filter((s) => localDate(new Date(s.at)) === dateStr);
    const byMethod = { cash: { count: 0, total: 0 }, card: { count: 0, total: 0 } };
    const items = new Map();
    let discount = 0;
    for (const s of sales) {
      byMethod[s.method].count += 1;
      byMethod[s.method].total += s.total;
      discount += s.discount || 0;
      for (const l of s.lines) {
        const it = items.get(l.productId) || { name: l.name, unit: l.unit, qty: 0, total: 0 };
        it.qty = round2(it.qty + l.qty);
        it.total += l.total;
        items.set(l.productId, it);
      }
    }
    return {
      date: dateStr,
      count: sales.length,
      total: byMethod.cash.total + byMethod.card.total,
      discount,
      byMethod,
      items: [...items.values()].sort((a, b) => b.total - a.total),
      sales: sales.map((s) => ({ no: s.no, at: s.at, method: s.method, total: s.total })),
    };
  }

  // ---------- settings ----------
  updateSettings(patch) {
    const s = this.data.settings;
    if ('shopName' in patch) s.shopName = String(patch.shopName || '').trim() || 'BGF420 Clubhouse';
    if ('tagline' in patch) s.tagline = String(patch.tagline || '').trim();
    if ('slogan' in patch) s.slogan = String(patch.slogan || '').trim();
    if ('videoIntervalMin' in patch) s.videoIntervalMin = clamp(Number(patch.videoIntervalMin), 1, 120);
    if ('resumeDelaySec' in patch) s.resumeDelaySec = clamp(Number(patch.resumeDelaySec), 0, 600);
    if ('videoSound' in patch) s.videoSound = Boolean(patch.videoSound);
    if ('autoStart' in patch) s.autoStart = Boolean(patch.autoStart);
    this.save();
    return s;
  }

  // ---------- videos ----------
  addVideo(file, name) {
    const v = { id: newId(), file, name, enabled: true, addedAt: new Date().toISOString() };
    this.data.videos.push(v);
    this.save();
    return v;
  }

  setVideoEnabled(id, enabled) {
    const v = this.data.videos.find((x) => x.id === id);
    if (!v) throw new StoreError('Video not found.');
    v.enabled = Boolean(enabled);
    this.save();
    return v;
  }

  removeVideo(id) {
    const v = this.data.videos.find((x) => x.id === id);
    if (!v) throw new StoreError('Video not found.');
    this.data.videos = this.data.videos.filter((x) => x.id !== id);
    this.save();
    return v;
  }
}

// The price a product sells for right now: its special price when it has one.
function effectivePrice(p) {
  return p.specialPrice !== null && p.specialPrice !== undefined && p.specialPrice < p.price ? p.specialPrice : p.price;
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

module.exports = { Store, StoreError, localDate, effectivePrice };
