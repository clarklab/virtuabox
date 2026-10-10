// UI kit: menus with a glove cursor, the bottom-screen views, screen wipes,
// typewriter dialog, rubber stamps and count-ups. Everything animates in
// stepped frames (see styles.css) so the menus read like sprite animation.

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Menus. Any element with [data-mi] inside `root` is an item. Arrow keys move
// the glove, Enter/Space picks, Escape backs out; touch and mouse pick directly.
let active = null;

export class Menu {
  constructor(root, { onPick, onBack, sound } = {}) {
    this.root = root;
    this.onPick = onPick;
    this.onBack = onBack;
    this.sound = sound;
    this.i = 0;
    root.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const it = e.target.closest('[data-mi]');
      const i = this.items().indexOf(it);
      if (i >= 0 && i !== this.i) this.focus(i);
    });
    root.addEventListener('click', (e) => {
      const it = e.target.closest('[data-mi]');
      const i = this.items().indexOf(it);
      if (i < 0 || active !== this) return;
      this.focus(i, true);
      this.pick(true);
    });
  }

  items() {
    return $$('[data-mi]', this.root).filter((el) => !el.disabled && !el.hidden && el.offsetParent !== null);
  }

  activate(i = this.i) {
    active = this;
    this.focus(i, true);
  }

  deactivate() {
    if (active === this) active = null;
  }

  get isActive() {
    return active === this;
  }

  focus(i, silent = false) {
    const items = this.items();
    if (!items.length) return;
    i = ((i % items.length) + items.length) % items.length;
    if (i !== this.i && !silent) this.sound?.ui('move');
    this.i = i;
    items.forEach((el, k) => el.classList.toggle('sel', k === i));
  }

  focusId(id) {
    const i = this.items().findIndex((el) => el.dataset.mi === id);
    if (i >= 0) this.focus(i, true);
  }

  move(d) {
    this.focus(this.i + d);
  }

  /** `viaClick` lets a link item keep its native click (e.g. a download). */
  pick(viaClick = false) {
    const el = this.items()[this.i];
    if (!el) return;
    el.classList.remove('press');
    void el.offsetWidth;
    el.classList.add('press');
    setTimeout(() => el.classList.remove('press'), 200);
    this.onPick?.(el.dataset.mi, el, viaClick);
  }
}

/** Route a keydown to the active menu. Returns true if it was handled. */
export function menuKey(e) {
  if (!active) return false;
  switch (e.key) {
    case 'ArrowUp':
    case 'ArrowLeft':
      active.move(-1);
      return true;
    case 'ArrowDown':
    case 'ArrowRight':
      active.move(1);
      return true;
    case 'Enter':
    case ' ':
      active.pick();
      return true;
    case 'Escape':
    case 'Backspace':
      active.onBack?.();
      return true;
    default:
      return false;
  }
}

export const activeMenu = () => active;

// ---------------------------------------------------------------------------
/** The bottom screen: one view at a time, each a window that opens and closes. */
export class Screen2 {
  constructor(root, cover, sound) {
    this.root = root;
    this.cover = cover; // the controller deck it sits over
    this.sound = sound;
    this.cur = null;
    this.next = null; // where we're headed (set synchronously)
    this.token = 0;
  }

  view(name) {
    return $(`[data-view="${name}"]`, this.root);
  }

  /** Hide at once (behind a screen wipe). */
  hideNow() {
    this.token++;
    this.next = null;
    active?.deactivate();
    if (this.cur) this.view(this.cur).classList.remove('show', 'closing');
    this.cur = null;
    this.root.classList.remove('show');
    this.cover.inert = false;
  }

  async show(name, { menu, focus } = {}) {
    const my = ++this.token;
    this.next = name;
    active?.deactivate();
    if (this.cur && this.cur !== name) {
      const prev = this.view(this.cur);
      prev.classList.add('closing');
      await sleep(100);
      prev.classList.remove('show', 'closing');
    }
    if (my !== this.token) return;
    this.cur = name;
    if (!name) {
      this.root.classList.remove('show');
      this.cover.inert = false;
      return;
    }
    this.root.classList.add('show');
    this.cover.inert = true;
    const v = this.view(name);
    v.classList.remove('show');
    void v.offsetWidth;
    v.classList.add('show');
    this.sound?.ui('open');
    if (menu) {
      menu.activate(0);
      if (focus) menu.focusId(focus);
    }
  }
}

// ---------------------------------------------------------------------------
/** Bars close over the whole app, `mid` runs behind them, then they open. */
export async function wipe(el, mid, sound) {
  if (!el.dataset.ready) {
    $$('i', el).forEach((b, i) => b.style.setProperty('--i', i));
    el.dataset.ready = '1';
  }
  sound?.ui('wipe');
  el.className = 'in';
  await sleep(240 + 11 * 14);
  el.className = 'hold';
  await mid?.();
  await sleep(60);
  el.className = 'out';
  await sleep(240 + 11 * 14);
  el.className = '';
}

// ---------------------------------------------------------------------------
/**
 * Typewriter text that never reflows: the untyped rest of the line is laid
 * out invisibly, so words don't jump between lines as they appear.
 */
export function typeText(el, text, { cps = 48, sound } = {}) {
  el._tw?.finish();
  const on = document.createElement('span');
  const off = document.createElement('span');
  off.className = 'tw-off';
  off.textContent = text;
  el.replaceChildren(on, off);
  let i = 0;
  let done;
  const p = new Promise((r) => { done = r; });
  const finish = () => {
    clearInterval(id);
    on.textContent = text;
    off.textContent = '';
    el._tw = null;
    done();
  };
  const id = setInterval(() => {
    i++;
    on.textContent = text.slice(0, i);
    off.textContent = text.slice(i);
    if (i % 2 === 1 && text[i - 1] !== ' ') sound?.ui('type');
    if (i >= text.length) finish();
  }, 1000 / cps);
  el._tw = { finish };
  return p;
}

// ---------------------------------------------------------------------------
/** A rubber stamp slammed into `host`. */
export function stamp(host, text, { cls = '', life = 1400, sound } = {}) {
  const d = document.createElement('div');
  d.className = `stamp ${cls}`;
  d.textContent = text;
  host.appendChild(d);
  sound?.ui('stamp');
  if (life) setTimeout(() => d.remove(), life);
  return d;
}

/** Tick a number up with arcade counter blips. */
export function countUp(el, to, { dur = 900, sound, fmt = (v) => v.toLocaleString() } = {}) {
  return new Promise((res) => {
    const t0 = performance.now();
    let lastBlip = 0;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      el.textContent = fmt(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (now - lastBlip > 45 && k < 1) {
        lastBlip = now;
        sound?.ui('count');
      }
      if (k < 1) requestAnimationFrame(step);
      else res();
    };
    requestAnimationFrame(step);
  });
}

/** Split an element's text into per-letter spans (for the logo drop). */
export function letters(el, start = 0) {
  const text = el.textContent;
  el.textContent = '';
  [...text].forEach((ch, i) => {
    const s = document.createElement('i');
    s.textContent = ch;
    s.style.setProperty('--i', start + i);
    el.appendChild(s);
  });
  return start + text.length;
}

/** Five-pip stat meter. */
export function meter(el, n, max = 5) {
  el.innerHTML = Array.from({ length: max }, (_, i) => `<i class="${i < n ? 'on' : ''}" style="--i:${i}"></i>`).join('');
}
