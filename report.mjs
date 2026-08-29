// Миксмастер — ежедневный отчёт продаж по месяцам → Telegram
// Работает на GitHub Actions (без участия Mac). Авторизация в Яндекс.Билеты — через куку сессии (секрет YANDEX_COOKIE).
// Node 20+ (глобальный fetch). Зависимость: cheerio.

import * as cheerio from 'cheerio';
import fs from 'node:fs';

const COOKIE = (process.env.YANDEX_COOKIE || '').trim();
const TG_TOKEN = (process.env.TG_TOKEN || '').trim();
const CHAT_ID = (process.env.CHAT_ID || '').trim();
const CAB = '30513587';                    // кабинет ООО Миксмастер
const BASE = 'https://cms.tickets.yandex.ru';
const SNAP_FILE = 'snapshot.json';

if (!COOKIE || !TG_TOKEN || !CHAT_ID) {
  console.error('Нет обязательных секретов: YANDEX_COOKIE / TG_TOKEN / CHAT_ID');
  process.exit(1);
}

// --- единый cookie-jar: стартуем с секрета, до-мёржим Set-Cookie от /city ---
let cookie = COOKIE;
function mergeSetCookie(res) {
  const sc = res.headers.get('set-cookie');
  if (!sc) return;
  // грубый разбор: name=value; ...
  for (const part of sc.split(/,(?=[^ ;]+=)/)) {
    const kv = part.split(';')[0].trim();
    if (/^[^=]+=/.test(kv)) {
      const name = kv.split('=')[0];
      cookie = cookie.replace(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '=[^;]*'), '').replace(/^; /, '').trim();
      cookie = (cookie ? cookie + '; ' : '') + kv;
    }
  }
}
async function get(path) {
  const res = await fetch(BASE + path, {
    headers: {
      'Cookie': cookie,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru-RU,ru;q=0.9',
    },
    redirect: 'manual',
  });
  mergeSetCookie(res);
  const body = await res.text();
  return { status: res.status, location: res.headers.get('location') || '', body };
}

function looksLikeLogin(r) {
  if (r.status >= 300 && r.status < 400 && /passport\.yandex/i.test(r.location)) return true;
  if (/passport\.yandex|Войдите|Авторизуйтесь|id=["']passp/i.test(r.body) && !/js-city-select|repertoire/i.test(r.body)) return true;
  return false;
}

const pad = n => String(n).padStart(2, '0');
const now = new Date();
const curKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
const FROM = `01.${pad(now.getMonth() + 1)}.${now.getFullYear()}`;
const t2 = new Date(now.getTime() + 400 * 864e5);
const TO = `${pad(t2.getDate())}.${pad(t2.getMonth() + 1)}.${t2.getFullYear()}`;

async function orgs() {
  const r = await get('/repertoire/organizers/');
  if (looksLikeLogin(r)) throw new Error('AUTH_FAILED: не залогинен (organizers)');
  const $ = cheerio.load(r.body);
  const ids = [];
  let stop = false;
  $('table tr').each((_, tr) => {
    if (stop) return;
    const txt = $(tr).text();
    if (/Архив/.test(txt)) { stop = true; return; }
    if ($(tr).find('td').length === 0) return;
    const m = $.html(tr).match(/\b(\d{6,9})\b/);
    if (m) ids.push(m[1]);
  });
  return ids;
}

async function activeSet(oid) {
  const r = await get(`/reports/tickets/organizer?report=1&event_date_from=${FROM}&event_date_to=${TO}&organizer_id=${oid}&ext=0`);
  if (looksLikeLogin(r)) throw new Error('AUTH_FAILED: не залогинен (ext=0)');
  const $ = cheerio.load(r.body);
  const s = new Set();
  $('table tr').each((_, tr) => {
    const c = $(tr).find('td');
    if (c.length < 15) return;
    const dt = $(c[1]).text().trim();
    if (!/^\d{2}\.\d{2}\.\d{4}/.test(dt)) return;
    if ($(c[2]).text().trim() !== '') return; // непустая колонка = закрыто/архив — такие в актив не попадают
    const name = $(c[0]).text().replace(/\s+/g, ' ').trim();
    s.add(`${name}|${dt.split(' ')[0]}`);
  });
  return s;
}

async function evData(oid) {
  const r = await get(`/reports/tickets/organizer?report=1&event_date_from=${FROM}&event_date_to=${TO}&organizer_id=${oid}&ext=1`);
  if (looksLikeLogin(r)) throw new Error('AUTH_FAILED: не залогинен (ext=1)');
  const $ = cheerio.load(r.body);
  let cur = null;
  const acc = {};
  $('table tr').each((_, tr) => {
    const c = $(tr).find('td,th');
    if (c.length === 1) {
      const t = $(c[0]).text().replace(/\s+/g, ' ').trim();
      const m = t.match(/^(.*)\((\d{2}\.\d{2}\.\d{4})[^)]*\)\s*$/);
      cur = m ? { name: m[1].trim(), date: m[2] } : null;
      return;
    }
    if (c.length === 17 && cur) {
      const v = c.map((i, el) => $(el).text().replace(/\s+/g, ' ').trim()).get();
      if (v[0] === '') return;
      const price = parseFloat(v[0].replace(/\s+/g, '')) || 0;
      const bil = parseInt(v[11].replace(/[^\d]/g, '')) || 0;
      const sum = parseInt(v[12].replace(/[^\d]/g, '')) || 0;
      const k = `${cur.name}|${cur.date}`;
      if (!acc[k]) acc[k] = { name: cur.name, date: cur.date, paid: 0, free: 0, rev: 0 };
      if (price > 0) { acc[k].paid += bil; acc[k].rev += sum; } else acc[k].free += bil;
    }
  });
  return Object.values(acc);
}

async function tg(text) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error('Telegram error: ' + JSON.stringify(j));
}

(async () => {
  await get('/city?id=' + CAB);
  const os = await orgs();
  if (!os.length) throw new Error('Организаторы кабинета не найдены (кука протухла или кабинет пуст)');
  const act = new Set();
  let evs = [];
  for (const oid of os) {
    (await activeSet(oid)).forEach(x => act.add(x));
    evs = evs.concat(await evData(oid));
  }

  const MN = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const months = {};
  for (const e of evs) {
    if (/^тест/i.test(e.name)) continue;
    if (!act.has(`${e.name}|${e.date}`)) continue; // «закрытые» (не активные) мероприятия сюда не попадают
    const [, mm, yy] = e.date.split('.');
    const key = `${yy}-${mm}`;
    if (key < curKey) continue;
    if (!months[key]) months[key] = { y: +yy, m: +mm, paid: 0, free: 0, rev: 0, count: 0 };
    months[key].paid += e.paid; months[key].free += e.free; months[key].rev += e.rev;
    months[key].count += 1;
  }
  const keys = Object.keys(months).sort();

  const prev = fs.existsSync(SNAP_FILE) ? JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8') || '{}') : {};
  const pm = prev.months || null;
  const fmt = n => n.toLocaleString('ru-RU');
  const dstr = d => d === 0 ? ' (0)' : ` (${d > 0 ? '+' : '-'}${fmt(Math.abs(d))})`;
  const dl = (k, field, cur) => (!pm || !pm[k] || typeof pm[k][field] !== 'number') ? '' : dstr(cur - pm[k][field]);
  const dateStr = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}`;

  for (const k of keys) {
    const x = months[k];
    const avg = x.paid ? Math.round(x.rev / x.paid) : 0;
    let avgd = '';
    if (pm && pm[k] && pm[k].paid) avgd = dstr(avg - Math.round(pm[k].rev / pm[k].paid));
    const msg =
      `📊 Миксмастер · ${MN[x.m]} ${x.y} (на ${dateStr})\n` +
      `💰 Сумма: ${fmt(x.rev)} р.${dl(k, 'rev', x.rev)}\n` +
      `🎫 Билетов: ${fmt(x.paid)}${dl(k, 'paid', x.paid)}\n` +
      `🎟️ Пригл.: ${fmt(x.free)}${dl(k, 'free', x.free)}\n` +
      `🎪 Мероприятий: ${fmt(x.count)}${dl(k, 'count', x.count)}\n` +
      `🏛️ Ср.чек: ${fmt(avg)} р.${avgd}`;
    await tg(msg);
    await new Promise(z => setTimeout(z, 350));
  }

  if (keys.length) {
    const tot = { rev: 0, paid: 0, free: 0, count: 0 };
    for (const k of keys) {
      tot.rev += months[k].rev; tot.paid += months[k].paid; tot.free += months[k].free; tot.count += months[k].count;
    }
    const totAvg = tot.paid ? Math.round(tot.rev / tot.paid) : 0;

    let ptot = null;
    if (pm) {
      ptot = { rev: 0, paid: 0, free: 0, count: 0 };
      let anyCount = false;
      for (const k of Object.keys(pm)) {
        ptot.rev += pm[k].rev || 0;
        ptot.paid += pm[k].paid || 0;
        ptot.free += pm[k].free || 0;
        if (typeof pm[k].count === 'number') { ptot.count += pm[k].count; anyCount = true; }
      }
      if (!anyCount) ptot.count = null; // в старом снэпшоте ещё нет данных по кол-ву мероприятий
    }
    const dtot = (field, cur) => (!ptot || ptot[field] === null || typeof ptot[field] !== 'number') ? '' : dstr(cur - ptot[field]);
    const totAvgD = (ptot && ptot.paid) ? dstr(totAvg - Math.round(ptot.rev / ptot.paid)) : '';

    const totalMsg =
      `📊 Миксмастер · ИТОГО (на ${dateStr})\n` +
      `💰 Сумма: ${fmt(tot.rev)} р.${dtot('rev', tot.rev)}\n` +
      `🎫 Билетов: ${fmt(tot.paid)}${dtot('paid', tot.paid)}\n` +
      `🎟️ Пригл.: ${fmt(tot.free)}${dtot('free', tot.free)}\n` +
      `🎪 Мероприятий: ${fmt(tot.count)}${dtot('count', tot.count)}\n` +
      `🏛️ Ср.чек: ${fmt(totAvg)} р.${totAvgD}`;
    await tg(totalMsg);
    await new Promise(z => setTimeout(z, 350));
  }

  const snap = { date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, months: {} };
  for (const k of keys) { const x = months[k]; snap.months[k] = { rev: x.rev, paid: x.paid, free: x.free, count: x.count }; }
  fs.writeFileSync(SNAP_FILE, JSON.stringify(snap, null, 2));
  console.log(`OK: отправлено месяцев ${keys.length}${keys.length ? ' + итого' : ''}`);
})().catch(e => { console.error(e.message || e); process.exit(1); });
