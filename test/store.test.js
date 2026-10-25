'use strict';
// Run with: npm test   (plain Node, no Electron needed)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, localDate } = require('../src/main/store');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobbies-'));
  return new Store(path.join(dir, 'data.json'));
}

test('starts with the default categories', () => {
  const s = freshStore();
  assert.deepStrictEqual(s.publicState().categories.map((c) => c.name),
    ['Bud', 'Pre-rolls', 'Edibles', 'Oils', 'Accessories']);
});

test('sale deducts stock, records cash change, and survives reload', () => {
  const s = freshStore();
  const bud = s.data.categories[0];
  const pre = s.data.categories[1];
  const og = s.saveProduct({ name: 'OG Kush', categoryId: bud.id, unit: 'g', weighed: true, price: 12000, stock: 50, lowStock: 10 });
  const joint = s.saveProduct({ name: 'House Joint', categoryId: pre.id, unit: 'joint', price: 5000, stock: 20, lowStock: 5 });

  const sale = s.completeSale({
    lines: [{ productId: og.id, qty: 1.5 }, { productId: joint.id, qty: 2 }, { productId: og.id, qty: 0.5 }],
    method: 'cash',
    tendered: 40000,
  });
  assert.strictEqual(sale.total, 12000 * 2 + 5000 * 2);
  assert.strictEqual(sale.change, 40000 - 34000);
  assert.strictEqual(sale.lines.length, 2, 'duplicate lines are merged');

  const reloaded = new Store(s.file);
  assert.strictEqual(reloaded.data.products.find((p) => p.id === og.id).stock, 48);
  assert.strictEqual(reloaded.data.products.find((p) => p.id === joint.id).stock, 18);

  const rep = reloaded.report(localDate(new Date()));
  assert.strictEqual(rep.count, 1);
  assert.strictEqual(rep.byMethod.cash.total, 34000);
  assert.strictEqual(rep.byMethod.card.total, 0);
});

test('refuses to oversell, short cash, or half a joint', () => {
  const s = freshStore();
  const p = s.saveProduct({ name: 'Gummy', categoryId: s.data.categories[2].id, unit: 'piece', price: 3000, stock: 3 });
  assert.throws(() => s.completeSale({ lines: [{ productId: p.id, qty: 4 }], method: 'card' }), /only 3/);
  assert.throws(() => s.completeSale({ lines: [{ productId: p.id, qty: 1 }], method: 'cash', tendered: 1000 }), /less than/);
  assert.throws(() => s.completeSale({ lines: [{ productId: p.id, qty: 0.5 }], method: 'card' }), /whole units/);
  assert.strictEqual(s.data.products[0].stock, 3, 'stock untouched after failed sales');
});

test('category in use cannot be deleted; reorder works', () => {
  const s = freshStore();
  const [bud, pre] = s.publicState().categories;
  s.saveProduct({ name: 'X', categoryId: bud.id, unit: 'g', weighed: true, price: 100 });
  assert.throws(() => s.deleteCategory(bud.id), /first/);
  s.moveCategory(pre.id, -1);
  assert.strictEqual(s.publicState().categories[0].name, 'Pre-rolls');
});

test('specials sell at the special price and record the discount', () => {
  const s = freshStore();
  const p = s.saveProduct({ name: 'Gelato', categoryId: s.data.categories[0].id, unit: 'g', weighed: true, price: 15000, specialPrice: 12000, stock: 10 });
  assert.throws(() => s.saveProduct({ ...p, specialPrice: 15000 }), /lower/);
  const sale = s.completeSale({ lines: [{ productId: p.id, qty: 2 }], method: 'card' });
  assert.strictEqual(sale.total, 24000);
  assert.strictEqual(sale.subtotal, 30000);
  assert.strictEqual(sale.discount, 6000);
  s.saveProduct({ ...p, specialPrice: '' });
  assert.strictEqual(s.data.products[0].specialPrice, null);
});
