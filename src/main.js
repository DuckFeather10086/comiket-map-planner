import { Layout, PALETTE, colorOf } from './layout.js';
import { Store, parsePaste } from './store.js';
import { Viewer } from './viewer.js';
import { buildPdf, planMarkers } from './exporter.js';
import { markKey } from './mapdraw.js';
import { loadMap } from './pdfsource.js';

const LAYOUT_URL = 'data/C108.json';
const $ = id => document.getElementById(id);

const ui = {
  loader: $('loader'), loaderText: $('loader-text'),
  dayTabs: $('day-tabs'), hallTabs: $('hall-tabs'),
  list: $('entry-list'), listCount: $('list-count'),
  form: $('add-form'), code: $('in-code'), name: $('in-name'),
  note: $('in-note'), levels: $('in-level'), hint: $('code-hint'),
  levelHint: $('level-hint'),
  wrap: $('canvas-wrap'), stage: $('stage'), canvas: $('map-canvas'),
  markerCanvas: $('marker-canvas'),
  zoomLevel: $('zoom-level'), status: $('hover-status'),
};

let layout, store, viewer, mapBytes;
let editingId = null;
let activeId = null;

boot().catch(err => {
  console.error(err);
  ui.loaderText.textContent = `启动失败：${err.message}`;
});

async function boot() {
  layout = await Layout.load(LAYOUT_URL);
  store = new Store(layout.event);
  $('event-name').textContent = layout.event;
  buildLevels();

  ui.loaderText.textContent = '加载会场地图…';
  const { bytes, verified } = await loadMap(layout.doc);
  mapBytes = bytes;
  if (!verified) console.warn('map file differs from the one the layout was measured against');

  viewer = new Viewer({
    wrap: ui.wrap, stage: ui.stage, mapCanvas: ui.canvas,
    markerCanvas: ui.markerCanvas, layout,
  });
  await viewer.open(mapBytes);
  viewer.addEventListener('cellclick', ev => onCellClick(ev.detail));
  viewer.addEventListener('hover', ev => onHover(ev.detail));
  viewer.addEventListener('render', () => {
    ui.zoomLevel.textContent = `${Math.round(viewer.scale * 100)}%`;
  });

  buildPageTabs();
  wireUi();
  store.addEventListener('change', render);
  await viewer.show(0);
  await viewer.fitWidth();
  render();
  ui.loader.hidden = true;
}

/* --------------------------------------------------------------------- chrome */

/**
 * The priority picker: colour is the plan, so this is what a new entry means
 * rather than what shade it gets.  One radio per level, so it stays keyboard
 * navigable and the form resets to the level you were using.
 */
function buildLevels() {
  for (const level of PALETTE) {
    const label = document.createElement('label');
    label.className = 'level';
    label.style.setProperty('--c', level.css);
    label.style.setProperty('--ci', level.inkCss);
    label.title = level.label;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'level';
    radio.value = level.key;
    // defaultChecked, not checked: a form reset has to land back on a level
    radio.defaultChecked = level === PALETTE[0];

    const tag = document.createElement('b');
    tag.textContent = level.tag;
    const text = document.createElement('span');
    text.textContent = level.short;

    label.append(radio, tag, text);
    ui.levels.append(label);
  }
  ui.levels.addEventListener('change', showLevelHint);
  showLevelHint();
}

/** The level a new entry gets: whichever chip is selected. */
const currentLevel = () =>
  ui.levels.querySelector('input:checked')?.value ?? PALETTE[0].key;

function setLevel(key) {
  const wanted = colorOf(key).key;
  for (const radio of ui.levels.querySelectorAll('input')) {
    radio.checked = radio.value === wanted;
  }
  showLevelHint();
}

function showLevelHint() {
  ui.levelHint.textContent = colorOf(currentLevel()).label;
}

function buildPageTabs() {
  ui.hallTabs.innerHTML = '';
  layout.pages.forEach((page, index) => {
    const button = document.createElement('button');
    button.dataset.page = index;
    button.innerHTML = `${page.halls.join('・')}<span class="n" hidden>0</span>`;
    button.addEventListener('click', async () => {
      await viewer.show(index);
      render();
    });
    ui.hallTabs.append(button);
  });
}

function wireUi() {
  ui.dayTabs.addEventListener('click', ev => {
    const button = ev.target.closest('.day');
    if (!button) return;
    store.setDay(Number(button.dataset.day));
    for (const tab of ui.dayTabs.children) {
      tab.setAttribute('aria-selected', String(tab === button));
    }
    activeId = null;
    render();
  });

  ui.form.addEventListener('submit', ev => {
    ev.preventDefault();
    const code = ui.code.value.trim();
    if (!code) return;
    const patch = {
      code, name: ui.name.value.trim(),
      note: ui.note.value.trim(), color: currentLevel(),
    };
    if (editingId) {
      store.update(editingId, patch);
      setEditing(null);
    } else {
      activeId = store.add(patch).id;
    }
    ui.form.reset();
    setLevel(patch.color);
    ui.code.focus();
    updateHint();
  });

  ui.code.addEventListener('input', updateHint);

  $('zoom-in').addEventListener('click', () => viewer.zoomBy(1.25));
  $('zoom-out').addEventListener('click', () => viewer.zoomBy(0.8));
  $('zoom-fit').addEventListener('click', () => viewer.fitWidth());

  $('btn-sort').addEventListener('click', () => {
    const order = new Map(planMarkers(layout, store.forDay())
      .map((m, i) => [m.entry.id, i]));
    store.entries.sort((a, b) => (a.day - b.day)
      || (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
    store.save();
  });

  wirePaste();
  wireExport();
  wireMenu();
}

function updateHint() {
  const value = ui.code.value.trim();
  if (!value) {
    ui.hint.className = 'hint';
    ui.hint.innerHTML = '点地图上的格子最快 · 也可输入 <code>東ヨ-12a</code> / <code>ヨ12a</code>';
    return;
  }
  const r = layout.resolve(value);
  if (r.ok) {
    ui.hint.className = 'hint';
    ui.hint.textContent = r.wall
      ? `✓ ${r.hall} 壁 ${r.block}-${r.number}${r.sub}`
      : `✓ ${r.hall} ${r.block}ブロック ${r.number}${r.sub}`;
  } else if (r.reason === 'wall') {
    ui.hint.className = 'hint';
    ui.hint.textContent = `${r.hall} — 地图上没有这一格，会列在清单的「未定位」里`;
  } else if (r.reason === 'number') {
    ui.hint.className = 'hint bad';
    ui.hint.textContent = `${r.block} 区只有 1–${r.max} 号`;
  } else if (r.reason === 'block') {
    ui.hint.className = 'hint bad';
    ui.hint.textContent = `未知区块「${r.block}」`;
  } else {
    ui.hint.className = 'hint bad';
    ui.hint.textContent = '无法识别配置';
  }
}

/* --------------------------------------------------------------------- render */

function render() {
  const entries = store.forDay();
  const markers = planMarkers(layout, entries);
  const byEntry = new Map(markers.map(m => [m.entry.id, m]));

  ui.listCount.textContent = `${entries.length} 件`;

  const counts = new Map();
  for (const m of markers) {
    if (m.placed) counts.set(m.page, (counts.get(m.page) || 0) + 1);
  }
  for (const button of ui.hallTabs.children) {
    const index = Number(button.dataset.page);
    button.setAttribute('aria-pressed', String(index === viewer.pageIndex));
    const badge = button.querySelector('.n');
    badge.textContent = counts.get(index) || 0;
    badge.hidden = !counts.get(index);
  }

  viewer.drawMarkers(markers
    .filter(m => m.placed && m.page === viewer.pageIndex && m.rect)
    .map(m => ({ ...m, active: m.entry.id === activeId })));

  renderList(entries, byEntry);
}

function renderList(entries, byEntry) {
  const ordered = [...entries].sort((a, b) => {
    const ma = byEntry.get(a.id), mb = byEntry.get(b.id);
    if (!ma && !mb) return 0;
    if (!ma) return 1;
    if (!mb) return -1;
    return ma.index - mb.index;
  });

  ui.list.innerHTML = '';
  let hall = null;
  for (const entry of ordered) {
    const marker = byEntry.get(entry.id);
    const group = marker ? (marker.placed ? marker.hall : `${marker.hall}（未定位）`)
                         : '未识别';
    if (group !== hall) {
      hall = group;
      const head = document.createElement('li');
      head.className = 'hall';
      head.textContent = group;
      ui.list.append(head);
    }
    ui.list.append(renderRow(entry, marker));
  }
}

function renderRow(entry, marker) {
  const li = document.createElement('li');
  li.className = 'entry';
  li.classList.toggle('active', entry.id === activeId);
  li.classList.toggle('bad', !marker);

  const level = colorOf(entry.color);
  const badge = document.createElement('span');
  badge.className = 'idx';
  badge.style.background = level.css;
  badge.style.color = level.inkCss;
  badge.title = `${level.tag} ${level.label}`;
  badge.textContent = marker ? marker.index : '?';

  const body = document.createElement('div');
  body.className = 'body';
  const code = document.createElement('div');
  code.className = 'code';
  code.textContent = marker ? marker.code : entry.code;
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = [entry.name, entry.note].filter(Boolean).join(' · ') || ' ';
  body.append(code, name);

  const tools = document.createElement('div');
  tools.className = 'tools';
  tools.append(
    tool('✎', '编辑', ev => {
      ev.stopPropagation();
      setEditing(entry.id);
    }),
    tool('✕', '删除', ev => {
      ev.stopPropagation();
      store.remove(entry.id);
    }),
  );

  li.append(badge, body, tools);
  li.addEventListener('click', async () => {
    activeId = entry.id;
    if (marker && marker.placed) {
      if (marker.page !== viewer.pageIndex) await viewer.show(marker.page);
      render();
      viewer.focus(marker);
      return;
    }
    render();
  });
  return li;
}

function tool(glyph, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = glyph;
  button.title = title;
  button.addEventListener('click', onClick);
  return button;
}

function setEditing(id) {
  editingId = id;
  const submit = ui.form.querySelector('button[type=submit]');
  if (!id) {
    submit.textContent = '＋';
    ui.form.reset();
    showLevelHint();
    updateHint();
    return;
  }
  const entry = store.entries.find(e => e.id === id);
  ui.code.value = entry.code;
  ui.name.value = entry.name;
  ui.note.value = entry.note;
  setLevel(entry.color);
  submit.textContent = '✓';
  ui.code.focus();
  updateHint();
}

/* ------------------------------------------------------------ map interaction */

function onCellClick(hit) {
  const code = `${hit.hall}${hit.block}-${String(hit.number).padStart(2, '0')}`;
  const existing = store.forDay().find(e => {
    const r = layout.resolve(e.code);
    return r.ok && r.block === hit.block && r.number === hit.number;
  });
  if (existing) {
    activeId = existing.id;
    setEditing(existing.id);
    render();
    return;
  }
  activeId = store.add({ code, color: currentLevel() }).id;
}

function onHover(hit) {
  ui.status.textContent = hit
    ? `${hit.hall} ${hit.block}-${String(hit.number).padStart(2, '0')}`
    : '';
}

/* -------------------------------------------------------------------- dialogs */

function wirePaste() {
  const dlg = $('dlg-paste');
  $('btn-paste').addEventListener('click', () => dlg.showModal());
  $('paste-cancel').addEventListener('click', () => dlg.close());
  $('paste-ok').addEventListener('click', () => {
    // pasted rows come in at whichever level is selected, so a bulk import does
    // not silently claim everything is a must-go
    const level = currentLevel();
    const rows = parsePaste($('paste-text').value).map(row => ({ ...row, color: level }));
    if (rows.length) store.addMany(rows);
    $('paste-text').value = '';
    dlg.close();
  });
}

function wireExport() {
  const dlg = $('dlg-export');
  $('btn-export').addEventListener('click', () => {
    $('export-err').hidden = true;
    dlg.showModal();
  });
  $('export-cancel').addEventListener('click', () => dlg.close());
  $('export-ok').addEventListener('click', async () => {
    const days = [];
    if ($('opt-day1').checked) days.push(1);
    if ($('opt-day2').checked) days.push(2);
    if (!days.length) return;

    const button = $('export-ok');
    button.disabled = true;
    button.textContent = '生成中…';
    try {
      const files = await buildPdf({
        mapBytes, layout, store, days,
        options: {
          sitePlan: $('opt-plan').checked,
          zoomPages: $('opt-zoom').checked,
          checklist: $('opt-list').checked,
          splitDays: $('opt-split').checked,
        },
      });
      if (!files.length) throw new Error('所选日期没有任何条目');
      for (const file of files) download(file.name, file.bytes);
      dlg.close();
    } catch (err) {
      console.error(err);
      $('export-err').textContent = `生成失败：${err.message}`;
      $('export-err').hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = '生成';
    }
  });
}

function wireMenu() {
  const dlg = $('dlg-menu');
  $('btn-menu').addEventListener('click', () => dlg.showModal());
  $('menu-close').addEventListener('click', () => dlg.close());

  $('btn-save-json').addEventListener('click', () =>
    download(`${layout.event}_wishlist.json`, new TextEncoder().encode(store.toJSON())));
  $('btn-save-csv').addEventListener('click', () =>
    download(`${layout.event}_wishlist.csv`, new TextEncoder().encode('﻿' + store.toCSV())));

  $('btn-load-json').addEventListener('click', () => $('file-json').click());
  $('file-json').addEventListener('change', async ev => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      store.replace(JSON.parse(await file.text()).entries || []);
      dlg.close();
    } catch (err) {
      alert(`导入失败：${err.message}`);
    }
  });

  $('btn-clear').addEventListener('click', () => {
    if (confirm('确定清空当前活动的全部条目？此操作不可撤销。')) {
      store.clear();
      dlg.close();
    }
  });
}

function download(name, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
