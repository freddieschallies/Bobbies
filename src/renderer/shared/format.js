'use strict';
// Small helpers shared by the till and menu screens.
(function () {
  function money(cents) {
    const neg = cents < 0;
    const [r, c] = (Math.abs(cents) / 100).toFixed(2).split('.');
    return `${neg ? '-' : ''}R ${r.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${c}`;
  }
  function toCents(text) {
    const n = parseFloat(String(text).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
  }
  function num(text) {
    const n = parseFloat(String(text).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  }
  function qty(q, unit) {
    const n = Number.isInteger(q) ? String(q) : String(Math.round(q * 100) / 100);
    return `${n} ${unit}`;
  }
  function perUnit(p) {
    return `${money(p.price)} / ${p.unit}`;
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function isLow(p) {
    return p.stock > 0 && p.stock <= p.lowStock;
  }
  window.fmt = { money, toCents, num, qty, perUnit, esc, today, isLow };
})();
