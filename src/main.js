import { Layout, PALETTE, colorOf } from './layout.js';
import { Store, parsePaste } from './store.js';
import { loadMap } from './pdfsource.js';
import { Viewer } from './viewer.js';
import { buildPdf, planMarkers } from './exporter.js';

const LAYOUT_URL = 'data/C108.json';
const $ = id => document.getElementById(id);

const ui = {
  loader: $('loader'), loaderText: $('loader-text'),
  dayTabs: $('day-tabs'), pageTabs: $('page-tabs'),
  list: $('entry-list'), listCount: $('list-count'),
  form: $('add-form'), code: $('in-code'), name: $('in-name'),
  note: $('in-note'), color: $('in-color'), hint: $('code-hint'),
  wrap: $('canvas-wrap'), stage: $('stage'),
  banner: $('placing-banner'), bannerCode: $('placing-code'),
  zoomLevel: $('zoom-level'),
};

let layout, store, viewer, mapBytes;
let editingId = null;
let placingId = null;
let activeId = null;

boot().catch(err => {
  console.error(err);
  ui.loaderText.textContent = `启动失败：${err.message}`;
});

async function boot() {
  layout = await Layout.load(LAYOUT_URL);
  store = new Store(layout.event);
  $('event-name').textContent = layout.event;
  $('map-link').href = `https://www.comiket.co.jp/info-a/${layout.event}/${layout.doc.source}`;

  for (const c of PALETTE) {
    ui.color.append(new Option(c.label, c.key));
  }

  ui.loaderText.textContent = '加载会场地图…';
  const { bytes, verified } = await loadMap(layout.doc, askForPdf);
  mapBytes = bytes;
  if (!verified) {
    console.warn('map file differs from the one the layout was built against');
  }

  viewer = new Viewer({
    wrap: ui.wrap, stage: ui.stage,
    mapCanvas: $('map-canvas'), markerCanvas: $('marker-canvas'),
  });
  await viewer.open(mapBytes);
  viewer.addEventListener('mapclick', onMapClick);
  viewer.addEventListener('render', () => {
    ui.zoomLevel.textContent = `${Math.round(viewer.scale * 100)}%`;
  });

  buildPageTabs();
  await viewer.show(0);
  await viewer.fitWidth();

  wireUi();
  store.addEventListener('change', render);
  render();
  ui.loader.hidden = true;
}

/* ------------------------------------------------------------------ map file */

function askForPdf() {
  const dlg = $('dlg-source');
  const input = $('file-pdf');
  const drop = $('drop-zone');
  ui.loader.hidden = true;
  dlg.showModal();

  return new Promise(resolve => {
    const accept = file => {
      if (!file) return;
      if (file.type && file.type !== 'application/pdf') {
        $('source-err').textContent = '请选择 PDF 文件';
        $('source-err').hidden = false;
        return;
      }
      file.arrayBuffer().then(buf => {
        dlg.close();
        ui.loader.hidden = false;
        resolve(buf);
      });
    };
    input.addEventListener('change', () => accept(input.files[0]));
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('dragover', ev => {
      ev.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', ev => {
      ev.preventDefault();
      drop.classList.remove('over');
      accept(ev.dataTransfer.files[0]);
    });
  });
}

/* --------------------------------------------------------------------- chrome */

function buildPageTabs() {
  ui.pageTabs.innerHTML = '';
  layout.pages.forEach((page, index) => {
    const button = document.createElement('button');
    button.dataset.page = index;
    button.innerHTML = `${page.halls.join('・')}<span class="n" hidden>0</span>`;
    button.addEventListener('click', async () => {
      await viewer.show(index);
      render();
    });
    ui.pageTabs.append(button);
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
      note: ui.note.value.trim(), color: ui.color.value,
    };
    if (editingId) {
      store.update(editingId, patch);
      setEditing(null);
    } else {
      const entry = store.add(patch);
      activeId = entry.id;
    }
    ui.form.reset();
    ui.color.value = patch.color;
    ui.code.focus();
    updateHint();
  });

  ui.code.addEventListener('input', updateHint);

  $('zoom-in').addEventListener('click', () => viewer.zoomBy(1.25));
  $('zoom-out').addEventListener('click', () => viewer.zoomBy(0.8));
  $('zoom-fit').addEventListener('click', () => viewer.fitWidth());

  $('btn-sort').addEventListener('click', () => {
    const ordered = planMarkers(layout, store.forDay()).map(m => m.entry.id);
    const rank = new Map(ordered.map((id, i) => [id, i]));
    store.entries.sort((a, b) => {
      if (a.day !== b.day) return a.day - b.day;
      return (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9);
    });
    store.save();
  });

  $('placing-cancel').addEventListener('click', () => setPlacing(null));

  wirePaste();
  wireExport();
  wireMenu();
}

function updateHint() {
  const value = ui.code.value.trim();
  if (!value) {
    ui.hint.className = 'hint';
    ui.hint.innerHTML = '支持 <code>東ヨ-12a</code> / <code>ヨ12a</code> / <code>西1 あ-05b</code> 等写法';
    return;
  }
  const result = layout.resolve(value);
  if (result.ok) {
    ui.hint.className = 'hint';
    ui.hint.textContent = `✓ ${result.hall} ${result.block}ブロック ${result.number}${result.sub} — ${layout.page(result.page).halls.join('・')}`;
  } else if (result.reason === 'wall') {
    ui.hint.className = 'hint';
    ui.hint.textContent = `${result.hall}（${result.block}ブロック）— 壁区不支持自动定位，添加后按 📍 在地图上点选`;
  } else if (result.reason === 'number') {
    ui.hint.className = 'hint bad';
    ui.hint.textContent = `${result.block} 区只有 1–${result.max} 号`;
  } else if (result.reason === 'block') {
    ui.hint.className = 'hint bad';
    ui.hint.textContent = `未知区块「${result.block}」`;
  } else {
    ui.hint.className = 'hint bad';
    ui.hint.textContent = '无法识别配置，添加后可在地图上手动点选位置';
  }
}

/* --------------------------------------------------------------------- render */

function render() {
  const entries = store.forDay();
  const markers = planMarkers(layout, entries);
  const byEntry = new Map(markers.map(m => [m.entry.id, m]));

  ui.listCount.textContent = `${entries.length} 件`;

  const counts = new Map();
  for (const m of markers) counts.set(m.page, (counts.get(m.page) || 0) + 1);
  for (const button of ui.pageTabs.children) {
    const index = Number(button.dataset.page);
    button.setAttribute('aria-pressed', String(index === viewer.pageIndex));
    const badge = button.querySelector('.n');
    const n = counts.get(index) || 0;
    badge.textContent = n;
    badge.hidden = n === 0;
  }

  const info = new Map(entries.map(e => [e.id, layout.resolve(e.code)]));
  renderList(entries, byEntry, info);

  viewer.drawMarkers(markers
    .filter(m => m.page === viewer.pageIndex)
    .map(m => ({
      index: m.index,
      css: colorOf(m.entry.color).css,
      rect: m.rect,
      point: m.point,
      active: m.entry.id === activeId,
    })));
}

function renderList(entries, byEntry, info) {
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
    const resolved = info.get(entry.id);
    const group = marker ? marker.hall : (resolved.hall || '未识别');
    if (group !== hall) {
      hall = group;
      const head = document.createElement('li');
      head.className = 'hall';
      head.textContent = group;
      ui.list.append(head);
    }
    ui.list.append(renderRow(entry, marker, resolved));
  }
}

function renderRow(entry, marker, resolved) {
  const needsPin = !marker && resolved.reason === 'wall';
  const li = document.createElement('li');
  li.className = 'entry';
  li.classList.toggle('active', entry.id === activeId);
  li.classList.toggle('bad', !marker && !needsPin);
  li.classList.toggle('pinned', Boolean(entry.pin));

  const badge = document.createElement('span');
  badge.className = 'idx';
  badge.style.background = colorOf(entry.color).css;
  badge.textContent = marker ? marker.index : '?';

  const body = document.createElement('div');
  body.className = 'body';
  const code = document.createElement('div');
  code.className = 'code';
  code.textContent = marker ? marker.code : entry.code;
  const name = document.createElement('div');
  name.className = 'name';
  const detail = [entry.name, entry.note].filter(Boolean).join(' · ');
  name.textContent = needsPin ? (detail ? `${detail} · 按 📍 点选位置` : '按 📍 点选位置') : (detail || ' ');
  body.append(code, name);

  const tools = document.createElement('div');
  tools.className = 'tools';
  tools.append(
    tool('📍', entry.pin ? '清除手动位置' : '在地图上手动点选位置', async ev => {
      ev.stopPropagation();
      if (entry.pin) return store.update(entry.id, { pin: null });
      const target = marker?.page ?? resolved.page;
      if (Number.isInteger(target) && target !== viewer.pageIndex) {
        await viewer.show(target);
        render();
      }
      setPlacing(entry.id);
    }),
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
    const target = marker?.page ?? resolved.page;
    if (Number.isInteger(target) && target !== viewer.pageIndex) {
      await viewer.show(target);
    }
    render();
    if (marker) viewer.focus(marker);
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
    updateHint();
    return;
  }
  const entry = store.entries.find(e => e.id === id);
  ui.code.value = entry.code;
  ui.name.value = entry.name;
  ui.note.value = entry.note;
  ui.color.value = entry.color;
  submit.textContent = '✓';
  ui.code.focus();
  updateHint();
}

function setPlacing(id) {
  placingId = id;
  viewer.setPlacing(Boolean(id));
  ui.banner.hidden = !id;
  if (id) {
    const entry = store.entries.find(e => e.id === id);
    ui.bannerCode.textContent = entry.code;
  }
}

function onMapClick(ev) {
  if (!placingId) return;
  const { page, x, y } = ev.detail;
  store.update(placingId, { pin: { page, x, y } });
  setPlacing(null);
}

/* -------------------------------------------------------------------- dialogs */

function wirePaste() {
  const dlg = $('dlg-paste');
  $('btn-paste').addEventListener('click', () => dlg.showModal());
  $('paste-cancel').addEventListener('click', () => dlg.close());
  $('paste-ok').addEventListener('click', () => {
    const rows = parsePaste($('paste-text').value);
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
    download(`${layout.event}_wishlist.csv`,
             new TextEncoder().encode('﻿' + store.toCSV())));

  $('btn-load-json').addEventListener('click', () => $('file-json').click());
  $('file-json').addEventListener('change', async ev => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      store.replace(data.entries || []);
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
