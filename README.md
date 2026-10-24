# Bobbies POS

Point of sale for the shop, with a live menu on the TV.

One Windows PC runs everything. The till is on the main monitor; the menu
opens borderless and full screen on the second HDMI output (the TV, via the
HDMI extender). Stock and prices on the TV update the moment anything changes
on the till.

## What it does

**Till (operator screen)**
- Category tabs (Bud, Pre-rolls, Edibles, Oils, Accessories — all editable)
- Click a product, or just start typing its name and press **Enter**
- Products sold by weight ask for grams; others add one at a time
- **F1** cash (works out change) · **F2** card · **Esc** clear sale · **F10** settings
- **↑ ↓** pick a sale line · **+ −** change amount · **Del** remove line
- Won't sell more than what's in stock; stock comes off on every sale

**Settings** (one button / F10)
- Products & stock — add/edit products, price per unit, low-stock level, stock received or counted
- Categories — add, rename, reorder, delete
- Main screen & videos — upload promo videos, set how often they play, sound on/off
- Cash-up — daily totals split cash/card, what sold, every sale, printable
- General — shop name, start automatically when the PC switches on

**Menu (TV)**
- Shows only what's in stock, grouped by category, with price per unit
- **Low stock** badge when an item drops to its low-stock level; sold-out items disappear
- Text shrinks automatically so the whole menu always fits
- Every few minutes a random video takes over, then it goes back to the menu
- Videos shuffle — each one plays before any repeats
- **No videos while a customer is ordering** — the moment an item goes on a sale,
  any playing video stops, and none start until a short while after the sale is done
- Vertical (or any odd-shaped) videos play over a blurred copy of themselves, so
  there are never black bars

## Running it on the shop PC

1. Install [Node.js LTS](https://nodejs.org) on the PC.
2. Download this repo (green **Code** button → Download ZIP) and unzip it.
3. Open a terminal in the folder and run:
   ```
   npm install
   npm start
   ```
4. In Windows display settings, set the TV to **Extend these displays**.
   The menu jumps to the TV by itself; if not, use
   Settings → Main screen & videos → *Move menu to the TV*.

To make a proper installer (`Bobbies POS Setup.exe`) instead:
```
npm run dist
```
The installer lands in the `dist` folder.

## Where the data lives

`%APPDATA%\Bobbies POS\bobbies-data.json` (products, sales, settings) and the
`videos` folder next to it. Back up that folder to keep everything.

## Developing

- `npm test` runs the stock/sales tests (no Electron needed)
- `src/main/` — Electron main process, data store, preload bridge
- `src/renderer/till/` — operator screen
- `src/renderer/menu/` — TV menu (colours and fonts are variables at the top of `menu.css`)

Still to do: pick the card machine, and design the TV visuals in detail.
