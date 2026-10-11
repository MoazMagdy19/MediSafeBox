/* ===== MediSafe Box — script.js =====
   Frontend prototype only. All hardware (LED, buzzer, sensor, lock, OLED)
   and notifications (family / Telegram) are simulated in the browser.
   No dosage calculation or medical advice is performed.
*/
'use strict';

/* ---------- Constants ---------- */
const USER = 'تيتا';
const FAMILY = 'ماما';
const ESC_WARN = 5;      // simulated minutes -> family alert
const ESC_MISS = 15;     // simulated minutes -> missed dose
const SNOOZE_MIN = 2;    // simulated minutes
const START_CLOCK = 7 * 60 + 58; // demo clock starts at 07:58

const COMPS = {
  morning:   { icon: '🌅', ar: 'الصباح', en: 'Morning',   slot: 'الخانة الصباحية', order: 0 },
  afternoon: { icon: '☀️', ar: 'الظهر',  en: 'Afternoon', slot: 'خانة الظهر',      order: 1 },
  evening:   { icon: '🌙', ar: 'المساء', en: 'Evening',   slot: 'الخانة المسائية', order: 2 }
};
const COMP_KEYS = Object.keys(COMPS);

const STATUS_TEXT = {
  upcoming: '⚪ قادمة',
  due:      '🟡 موعد الجرعة',
  warn:     '🔴 الجرعة لم تؤخذ',
  taken:    '🟢 تم أخذ الجرعة',
  missed:   '🔴 جرعة فائتة'
};
const LED_TEXT = {
  upcoming: 'مطفأ',
  due:      'وامض',
  warn:     'وامض سريع',
  taken:    'أخضر',
  missed:   'أحمر'
};

const DEFAULT_MEDS = [
  { id: 1, comp: 'morning',   name: 'دواء الضغط',  time: 8 * 60 },
  { id: 2, comp: 'afternoon', name: 'دواء القلب',  time: 14 * 60 },
  { id: 3, comp: 'evening',   name: 'دواء المساء', time: 20 * 60 }
];

/* ---------- Helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hm(min) {
  const t = Math.floor(min) % 1440;
  return pad(Math.floor(t / 60)) + ':' + pad(t % 60);
}
function h12(min) {
  const t = Math.floor(min) % 1440;
  let h = Math.floor(t / 60);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return pad(h) + ':' + pad(t % 60) + ' ' + ap;
}
// DOM update helpers that skip no-op writes (keeps CSS animations smooth)
function setText(el, t) { if (el && el.textContent !== t) el.textContent = t; }
function setHTML(el, h) { if (el && el._h !== h) { el._h = h; el.innerHTML = h; } }
function setData(el, k, v) { if (el && el.dataset[k] !== v) el.dataset[k] = v; }

function toast(msg, kind = '') {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.classList.add('out'), 3800);
  setTimeout(() => t.remove(), 4400);
}

/* ---------- State ---------- */
let S;
let session = 0;

function resetRuntime(m) {
  m.status = 'upcoming';  // upcoming | due | taken | missed
  m.dueAt = null;
  m.takenAt = null;
  m.snoozeUntil = null;
  m.alerted = false;
  return m;
}
function newState(meds, keep) {
  return {
    clock: START_CLOCK,
    fast: keep ? keep.fast : false,
    sound: keep ? keep.sound : false,
    meds: meds.map(m => resetRuntime({ ...m })),
    history: [],
    family: [],
    confirm: null,   // { name, time, until }
    flash: null,     // { name, until } shown briefly after a missed dose
    sensor: { open: false, until: 0, target: null, msg: '', msgUntil: 0 },
    lockUntil: 0
  };
}

const medFor = key => S.meds.find(m => m.comp === key);
const elapsed = m => S.clock - m.dueAt;
const isSnoozed = m => m.snoozeUntil !== null && S.clock < m.snoozeUntil;
const dueMeds = () => S.meds.filter(m => m.status === 'due').sort((a, b) => a.dueAt - b.dueAt);
const buzzerOn = () => dueMeds().some(m => !isSnoozed(m));
function viewState(m) {
  if (m.status === 'due') return elapsed(m) >= ESC_WARN ? 'warn' : 'due';
  return m.status;
}

/* ---------- Core simulation ---------- */
function startDose(m, manual) {
  if (m.status === 'due') { toast('هذا الدواء مستحق بالفعل'); return; }
  if (manual && dueMeds().length === 0) S.clock = m.time; // jump demo clock to the scheduled time
  m.status = 'due';
  m.dueAt = S.clock;
  m.snoozeUntil = null;
  m.alerted = false;
  m.takenAt = null;
  toast('🔔 حان موعد ' + m.name, 'warn');
  render();
}

function checkEscalation(m) {
  const el = elapsed(m);
  if (el >= ESC_MISS) { markMissed(m); return; }
  if (el >= ESC_WARN && !m.alerted) {
    m.alerted = true;
    pushFamily(USER + ' لم تأخذ ' + m.name + ' حتى الآن.', 'alert');
    toast('⚠️ لم يتم أخذ الجرعة — 📱 تم إرسال تنبيه إلى ' + FAMILY, 'warn');
  }
}

function markTaken(m, via) {
  if (m.status !== 'due') return;
  m.status = 'taken';
  m.takenAt = S.clock;
  m.snoozeUntil = null;
  S.history.unshift({ t: hm(S.clock), name: m.name, comp: m.comp, type: 'taken' });
  S.confirm = { name: m.name, time: hm(S.clock), until: Date.now() + 7000 };
  S.lockUntil = Date.now() + 3000;
  if (m.alerted) pushFamily(USER + ' أخذت ' + m.name + ' الآن ✅', 'ok');
  toast('✓ تم تسجيل الجرعة' + (via === 'sensor' ? ' (من الحساس)' : ''), 'good');
  render();
}

function markMissed(m) {
  if (m.status !== 'due') return;
  m.status = 'missed';
  S.history.unshift({ t: hm(S.clock), name: m.name, comp: m.comp, type: 'missed' });
  S.flash = { name: m.name, until: Date.now() + 7000 };
  if (!m.alerted) {
    m.alerted = true;
    pushFamily(USER + ' لم تأخذ ' + m.name + ' حتى الآن.', 'alert');
  }
  toast('🔴 الجرعة فاتت — ' + m.name, 'warn');
  render();
}

function pushFamily(text, type) {
  S.family.push({ t: hm(S.clock), text, type });
}

function snooze() {
  const cur = dueMeds()[0];
  if (!cur || isSnoozed(cur)) return;
  cur.snoozeUntil = S.clock + SNOOZE_MIN;
  toast('⏰ سيتم التذكير بعد ' + SNOOZE_MIN + ' دقيقة');
  render();
}

function simulateOpen() {
  const sens = S.sensor;
  if (sens.open) return;
  const cur = dueMeds()[0];
  if (!cur) {
    sens.msg = 'لا توجد جرعة مستحقة الآن — شغّل موعد دواء أولاً';
    sens.msgUntil = Date.now() + 3500;
    render();
    return;
  }
  const my = session;
  sens.open = true;
  sens.until = Date.now() + 5000;
  sens.target = cur.id;
  render();
  setTimeout(() => {
    if (my !== session) return;
    if (cur.status === 'due') markTaken(cur, 'sensor');
  }, 1500);
  setTimeout(() => {
    if (my !== session) return;
    S.sensor.open = false;
    S.sensor.target = null;
    render();
  }, 5000);
}

/* ---------- Clock loop ---------- */
let last = Date.now();
let audioCtx = null;
let lastBeep = 0;

function beep() {
  if (!audioCtx || Date.now() - lastBeep < 900) return;
  lastBeep = Date.now();
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = 'square';
  o.frequency.value = 880;
  g.gain.value = 0.04;
  o.connect(g);
  g.connect(audioCtx.destination);
  o.start();
  o.stop(audioCtx.currentTime + 0.18);
}

function tick() {
  const now = Date.now();
  const dt = Math.min((now - last) / 1000, 3);
  last = now;
  const step = dt * (S.fast ? 1 : 1 / 60); // fast: 1 s = 1 simulated minute
  const prev = S.clock;
  S.clock = Math.min(S.clock + step, 1439.99);

  S.meds.forEach(m => {
    if (m.status === 'upcoming' && prev < m.time && S.clock >= m.time) startDose(m, false);
  });
  S.meds.forEach(m => { if (m.status === 'due') checkEscalation(m); });

  if (S.sound && buzzerOn()) beep();
  render();
}

/* ---------- Static DOM ---------- */
function buildStatic() {
  $('#med-cards').innerHTML = COMP_KEYS.map(k => {
    const c = COMPS[k];
    return `<article class="med-card" data-comp="${k}" data-state="upcoming">
      <div class="med-card-top"><span class="big-icon">${c.icon}</span><span>${c.ar} <small>${c.en}</small></span></div>
      <h3 class="mc-name"></h3>
      <div class="mc-time num"></div>
      <div class="status-pill mc-status"></div>
    </article>`;
  }).join('');

  $('#box-comps').innerHTML = COMP_KEYS.map(k => {
    const c = COMPS[k];
    return `<div class="comp" data-comp="${k}" data-state="upcoming" data-buzz="0">
      <div class="comp-head"><span class="comp-icon">${c.icon}</span><span>${c.ar}</span><small>${c.en}</small></div>
      <div class="led"></div>
      <div class="comp-med"></div>
      <div class="comp-time num"></div>
      <div class="comp-status"></div>
      <div class="comp-alert"><span class="alert-text">حان موعد الدواء</span> <span class="buzz">🔊</span></div>
    </div>`;
  }).join('');

  $('#hw-leds').innerHTML = COMP_KEYS.map(k => {
    const c = COMPS[k];
    return `<div class="hw-row" data-comp="${k}" data-state="upcoming">
      <span class="led"></span><span class="hw-label">${c.en} LED</span><span class="hw-val"></span>
    </div>`;
  }).join('');
}

/* ---------- Render ---------- */
function render() {
  renderClock();
  renderDemo();
  renderCardsAndBox();
  renderReminder();
  renderSensor();
  renderOled();
  renderHardware();
  renderHistory();
  renderFamily();
  renderSummary();
}

function renderClock() {
  setText($('#clock'), hm(S.clock));
}

function renderDemo() {
  const b = $('#btn-fast');
  b.setAttribute('aria-pressed', S.fast ? 'true' : 'false');
  $('#fast-badge').hidden = !S.fast;
  const snd = $('#btn-sound');
  snd.setAttribute('aria-pressed', S.sound ? 'true' : 'false');
  setText(snd, S.sound ? '🔊 الصوت: تشغيل' : '🔇 الصوت: إيقاف');

  const html = [...S.meds].sort((a, b) => COMPS[a.comp].order - COMPS[b.comp].order)
    .map(m => `<button class="btn btn-ghost" data-id="${m.id}">▶ ${COMPS[m.comp].icon} ${esc(m.name)}</button>`).join('');
  setHTML($('#triggers'), html);
}

function renderCardsAndBox() {
  COMP_KEYS.forEach(k => {
    const m = medFor(k);
    const st = viewState(m);
    const buzz = (st === 'due' || st === 'warn') && !isSnoozed(m) ? '1' : '0';

    const card = $(`#med-cards [data-comp="${k}"]`);
    setData(card, 'state', st);
    setText($('.mc-name', card), m.name);
    setText($('.mc-time', card), h12(m.time));
    setText($('.mc-status', card), STATUS_TEXT[st]);

    const comp = $(`#box-comps [data-comp="${k}"]`);
    setData(comp, 'state', st);
    setData(comp, 'buzz', buzz);
    setText($('.comp-med', comp), m.name);
    setText($('.comp-time', comp), h12(m.time));
    setText($('.comp-status', comp), STATUS_TEXT[st]);
    setText($('.alert-text', comp), st === 'warn' ? 'لم يتم أخذ الجرعة' : 'حان موعد الدواء');

    const row = $(`#hw-leds [data-comp="${k}"]`);
    setData(row, 'state', st);
    setText($('.hw-val', row), LED_TEXT[st]);
  });
}

function renderReminder() {
  const R = $('#reminder');
  const cur = dueMeds()[0];
  const now = Date.now();
  const stepEls = $$('#rem-steps .step');
  const setSteps = states => stepEls.forEach((s, i) => setData(s, 'state', states[i]));
  const btnTake = $('#btn-take');
  const btnSnooze = $('#btn-snooze');

  if (cur) {
    const el = elapsed(cur);
    const warn = el >= ESC_WARN;
    setData(R, 'state', warn ? 'warn' : 'due');
    setText($('#rem-title'), warn ? '⚠️ لم يتم أخذ الجرعة' : '🔔 حان موعد الدواء');
    setHTML($('#rem-med'), esc(cur.name));
    setText($('#rem-slot'), COMPS[cur.comp].slot);

    let msg = warn
      ? '📱 تم إرسال تنبيه إلى ' + FAMILY + ' — "' + USER + ' لم تأخذ ' + cur.name + ' حتى الآن."'
      : 'حان موعد ' + cur.name;
    if (isSnoozed(cur)) msg = '⏰ تم التأجيل — يعود التنبيه بعد ' + Math.ceil(cur.snoozeUntil - S.clock) + ' دقيقة';
    const others = dueMeds().length - 1;
    if (others > 0) msg += ' (+' + others + ' دواء آخر مستحق)';
    setText($('#rem-msg'), msg);

    setSteps(warn ? ['done', 'active', 'todo'] : ['active', 'todo', 'todo']);
    $('#rem-bar').style.width = Math.min(100, (el / ESC_MISS) * 100) + '%';
    setText($('#rem-elapsed'), 'مرّ ' + Math.floor(el) + ' دقيقة (محاكاة) — الجرعة تفوت بعد ' + ESC_MISS + ' دقيقة');
    btnTake.disabled = false;
    btnSnooze.disabled = isSnoozed(cur);
  } else if (S.confirm && S.confirm.until > now) {
    setData(R, 'state', 'taken');
    setText($('#rem-title'), '✓ تم تسجيل الجرعة');
    setHTML($('#rem-med'), 'تم أخذ ' + esc(S.confirm.name) + ' في <bdi dir="ltr">' + S.confirm.time + '</bdi>');
    setText($('#rem-slot'), '');
    setText($('#rem-msg'), '🟢 تم أخذ الجرعة');
    setSteps(['todo', 'todo', 'todo']);
  } else if (S.flash && S.flash.until > now) {
    setData(R, 'state', 'missed');
    setText($('#rem-title'), '🔴 الجرعة فاتت');
    setHTML($('#rem-med'), esc(S.flash.name));
    setText($('#rem-slot'), 'تمت إضافتها إلى سجل الجرعات');
    setText($('#rem-msg'), esc2(S.flash.name) + ' — جرعة فائتة');
    setSteps(['done', 'done', 'active']);
  } else {
    setData(R, 'state', 'idle');
    const next = nextUpcoming();
    setText($('#rem-title'), 'في انتظار موعد الدواء القادم');
    setHTML($('#rem-med'), next ? esc(next.name) : 'تم الانتهاء من جرعات اليوم');
    setText($('#rem-slot'), next ? COMPS[next.comp].slot + ' — ' + h12(next.time) : '');
    setText($('#rem-msg'), '');
    setSteps(['todo', 'todo', 'todo']);
    $('#rem-bar').style.width = '0%';
  }
}
function esc2(s) { return String(s); }

function nextUpcoming() {
  const up = S.meds.filter(m => m.status === 'upcoming').sort((a, b) => a.time - b.time);
  return up.find(m => m.time >= S.clock) || up[0] || null;
}

function renderSensor() {
  const card = $('#sensor-card');
  const sens = S.sensor;
  const now = Date.now();
  const btn = $('#btn-open');
  if (sens.open) {
    const m = S.meds.find(x => x.id === sens.target);
    setData(card, 'state', 'open');
    setText($('#sensor-icon'), '🟢');
    setText($('#sensor-text'), 'تم فتح الخانة');
    setText($('#sensor-sub'), m && m.status === 'taken'
      ? '✓ تم اكتشاف إزالة الدواء — تم تسجيل الجرعة تلقائيًا'
      : 'تم اكتشاف إزالة الدواء… جارٍ تسجيل الجرعة');
    btn.disabled = true;
  } else if (sens.msg && sens.msgUntil > now) {
    setData(card, 'state', 'note');
    setText($('#sensor-icon'), '🔘');
    setText($('#sensor-text'), 'في انتظار فتح الخانة...');
    setText($('#sensor-sub'), sens.msg);
    btn.disabled = false;
  } else {
    setData(card, 'state', 'waiting');
    setText($('#sensor-icon'), '🔘');
    setText($('#sensor-text'), 'في انتظار فتح الخانة...');
    setText($('#sensor-sub'), '');
    btn.disabled = false;
  }
}

function renderOled() {
  const o = $('#oled');
  const cur = dueMeds()[0];
  const now = Date.now();
  let st = 'idle';
  let lines;
  if (cur && isSnoozed(cur)) {
    st = 'due';
    lines = ['SNOOZED', cur.name, h12(cur.time), 'BACK IN ' + Math.ceil(cur.snoozeUntil - S.clock) + ' MIN'];
  } else if (cur && elapsed(cur) >= ESC_WARN) {
    st = 'warn';
    lines = ['NOT TAKEN!', cur.name, h12(cur.time), 'FAMILY ALERTED'];
  } else if (cur) {
    st = 'due';
    lines = ['DOSE TIME', cur.name, h12(cur.time), 'TAKE MEDICATION'];
  } else if (S.confirm && S.confirm.until > now) {
    st = 'taken';
    lines = ['DOSE TAKEN ✓', S.confirm.name, S.confirm.time, 'GOOD JOB'];
  } else if (S.flash && S.flash.until > now) {
    st = 'missed';
    lines = ['DOSE MISSED', S.flash.name, 'LOGGED', 'FAMILY NOTIFIED'];
  } else {
    const next = nextUpcoming();
    lines = next ? ['NEXT DOSE', next.name, h12(next.time), 'STANDBY'] : ['ALL DONE', '—', hm(S.clock), 'STANDBY'];
  }
  setData(o, 'state', st);
  setHTML($('#oled-body'),
    `<div class="o-head">${esc(lines[0])}</div>
     <div class="o-name">${esc(lines[1])}</div>
     <div class="o-time">${esc(lines[2])}</div>
     <div class="o-foot">${esc(lines[3])}</div>`);
}

function renderHardware() {
  const on = buzzerOn();
  setData($('#hw-buzzer'), 'on', on ? '1' : '0');
  setText($('#hw-buzzer-val'), on ? 'ON' : 'OFF');
  setData($('#box-speaker'), 'on', on ? '1' : '0');

  const cur = dueMeds()[0];
  const open = !!cur || Date.now() < S.lockUntil || S.sensor.open;
  setData($('#hw-lock'), 'open', open ? '1' : '0');
  setText($('#hw-lock-ico'), open ? '🔓' : '🔒');
  setText($('#hw-lock-val'), open ? (cur ? 'مفتوح — ' + COMPS[cur.comp].slot : 'مفتوح') : 'مغلق');
}

function renderHistory() {
  const taken = S.meds.filter(m => m.status === 'taken').length;
  const missed = S.meds.filter(m => m.status === 'missed').length;
  const pending = S.meds.length - taken - missed;
  setHTML($('#hist-chips'),
    `<span class="chip ok">🟢 تم أخذها: ${taken}</span>
     <span class="chip bad">🔴 فائتة: ${missed}</span>
     <span class="chip wait">⏳ قادمة: ${pending}</span>`);

  if (!S.history.length) {
    setHTML($('#hist-list'), '<div class="empty">لا توجد جرعات مسجلة بعد</div>');
    return;
  }
  setHTML($('#hist-list'), S.history.map(h =>
    `<div class="hist-item ${h.type}">
      <span class="hist-time num">${h.t}</span>
      <span class="hist-name">${COMPS[h.comp].icon} ${esc(h.name)}</span>
      <span class="hist-st">${h.type === 'taken' ? '🟢 تم أخذ الجرعة' : '🔴 جرعة فائتة'}</span>
    </div>`).join(''));
}

function renderFamily() {
  const active = S.meds.some(m => m.alerted && (m.status === 'due' || m.status === 'missed'));
  const card = $('#fam-card');
  setData(card, 'state', active ? 'alert' : 'ok');
  setText($('#fam-chip'), active ? '🔴 تنبيه جديد' : '🟢 لا توجد تنبيهات');
  const lastAlert = [...S.family].reverse().find(f => f.type === 'alert');
  setText($('#fam-text'), active && lastAlert ? lastAlert.text : 'كل شيء على ما يرام');
  setText($('#fam-sent'), active ? '✓ تم إرسال التنبيه' : '');
  setHTML($('#fam-msgs'), S.family.map(f =>
    `<div class="bubble ${f.type}">${f.type === 'alert' ? '🔔 ' : ''}${esc(f.text)}<small><bdi dir="ltr">${f.t}</bdi> ✓✓</small></div>`).join(''));
}

function renderSummary() {
  const total = S.meds.length;
  const taken = S.meds.filter(m => m.status === 'taken').length;
  const missed = S.meds.filter(m => m.status === 'missed').length;
  const pending = total - taken - missed;
  const pct = total ? Math.round((taken / total) * 100) : 0;
  setText($('#sum-total'), String(total));
  setText($('#sum-taken'), String(taken));
  setText($('#sum-missed'), String(missed));
  setText($('#sum-pending'), String(pending));
  setText($('#sum-pct'), pct + '%');
  $('#prog-taken').style.width = (total ? (taken / total) * 100 : 0) + '%';
  $('#prog-missed').style.width = (total ? (missed / total) * 100 : 0) + '%';
}

/* ---------- Settings ---------- */
function renderSettings() {
  const rows = [...S.meds].sort((a, b) => COMPS[a.comp].order - COMPS[b.comp].order);
  $('#settings-list').innerHTML = rows.map(m => {
    const c = COMPS[m.comp];
    return `<div class="set-row" data-id="${m.id}">
      <div class="set-slot"><span class="big-icon">${c.icon}</span><span>${c.ar}</span></div>
      <label>اسم الدواء<input class="in-name" type="text" value="${esc(m.name)}" maxlength="30"></label>
      <label>الوقت<input class="in-time" type="time" value="${hm(m.time)}"></label>
      <label>الخانة<select class="in-comp">${COMP_KEYS.map(k =>
        `<option value="${k}" ${k === m.comp ? 'selected' : ''}>${COMPS[k].icon} ${COMPS[k].ar}</option>`).join('')}</select></label>
    </div>`;
  }).join('');
}

function medFromEvent(e) {
  const row = e.target.closest('.set-row');
  return row ? S.meds.find(m => m.id === Number(row.dataset.id)) : null;
}

/* ---------- Events ---------- */
function bindEvents() {
  $('#btn-take').addEventListener('click', () => {
    const cur = dueMeds()[0];
    if (cur) markTaken(cur, 'button');
  });
  $('#btn-snooze').addEventListener('click', snooze);
  $('#btn-open').addEventListener('click', simulateOpen);

  $('#btn-fast').addEventListener('click', () => {
    S.fast = !S.fast;
    toast(S.fast ? '⚡ وضع العرض السريع مفعل' : 'تم إيقاف وضع العرض السريع');
    render();
  });

  $('#btn-sound').addEventListener('click', () => {
    S.sound = !S.sound;
    if (S.sound && !audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    render();
  });

  $('#btn-reset').addEventListener('click', () => {
    session++;
    S = newState(S.meds, S);
    renderSettings();
    toast('↺ تمت إعادة ضبط العرض');
    render();
  });

  $('#triggers').addEventListener('click', e => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    const m = S.meds.find(x => x.id === Number(b.dataset.id));
    if (m) startDose(m, true);
  });

  const list = $('#settings-list');
  list.addEventListener('input', e => {
    if (!e.target.classList.contains('in-name')) return;
    const m = medFromEvent(e);
    if (!m) return;
    m.name = e.target.value.trim() || 'دواء';
    render();
  });
  list.addEventListener('change', e => {
    const m = medFromEvent(e);
    if (!m) return;
    if (e.target.classList.contains('in-time')) {
      const v = e.target.value;
      if (!v) { e.target.value = hm(m.time); return; }
      const [h, mi] = v.split(':').map(Number);
      m.time = h * 60 + mi;
      render();
      toast('تم تحديث الوقت');
    } else if (e.target.classList.contains('in-comp')) {
      const newComp = e.target.value;
      const other = S.meds.find(x => x !== m && x.comp === newComp);
      if (other) other.comp = m.comp;
      m.comp = newComp;
      renderSettings();
      render();
      toast('تم تحديث الخانة');
    }
  });
}

/* ---------- Init ---------- */
function init() {
  S = newState(DEFAULT_MEDS, null);
  buildStatic();
  renderSettings();
  bindEvents();
  render();
  last = Date.now();
  setInterval(tick, 500);
}
init();
