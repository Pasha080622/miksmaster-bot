// Еженедельный отчёт — все концерты по ВСЕМ кабинетам Яндекс.Билетов → Telegram
// Работает на GitHub Actions. Авторизация — через куку сессии (секрет YANDEX_COOKIE, тот же что и в ежедневном отчёте).
// Node 20+ (глобальный fetch). Зависимость: нет внешних (только глобальный DOMParser заменён на ручной cheerio-парсинг, как в report.mjs).

import * as cheerio from 'cheerio';
import fs from 'node:fs';

const COOKIE = (process.env.YANDEX_COOKIE || '').trim();
const TG_TOKEN = (process.env.TG_TOKEN || '').trim();
const CHAT_ID = (process.env.WEEKLY_CHAT_ID || '').trim(); // «Продажи билетов / еженедельный отчет»
const BASE = 'https://cms.tickets.yandex.ru';
const SNAP_FILE = 'snapshot-weekly.json';

if (!COOKIE || !TG_TOKEN || !CHAT_ID) {
  console.error('Нет обязательных секретов: YANDEX_COOKIE / TG_TOKEN / WEEKLY_CHAT_ID');
  process.exit(1);
}

// --- единый cookie-jar (как в report.mjs) ---
let cookie = COOKIE;
function mergeSetCookie(res) {
  const sc = res.headers.get('set-cookie');
  if (!sc) return;
  for (const part of sc.split(/,(?=[^ ;]+=)/)) {
    const kv = part.split(';')[0].trim();
    if (/^[^=]+=/.test(kv)) {
      const name = kv.split('=')[0];
      cookie = cookie.replace(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=[^;]*'), '').replace(/^; /, '').trim();
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
async function getJson(path) {
  const res = await fetch(BASE + path, {
    headers: { 'Cookie': cookie, 'Accept': 'application/json' },
  });
  mergeSetCookie(res);
  return res.json();
}
function looksLikeLogin(r) {
  if (r.status >= 300 && r.status < 400 && /passport\.yandex/i.test(r.location)) return true;
  if (/passport\.yandex|Войдите|Авторизуйтесь|id=["']passp/i.test(r.body) && !/js-city-select|repertoire/i.test(r.body)) return true;
  return false;
}

const pad = n => String(n).padStart(2, '0');
const now = new Date();
const FROM = `01.${pad(now.getMonth() + 1)}.${now.getFullYear()}`;
const t2 = new Date(now.getTime() + 400 * 864e5);
const TO = `${pad(t2.getDate())}.${pad(t2.getMonth() + 1)}.${t2.getFullYear()}`;

// --- список всех кабинетов (юрлиц) ---
async function cities() {
  const j = await getJson('/api/cities');
  return (j.cities || []).filter(c => c.status === 2).map(c => ({ id: String(c.id), name: c.name }));
}

// --- организаторы внутри кабинета (как в report.mjs) ---
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

// --- активные (не закрытые/архивные) мероприятия организатора ---
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
    if ($(c[2]).text().trim() !== '') return; // непустая колонка = закрыто/архив
    const name = $(c[0]).text().replace(/\s+/g, ' ').trim();
    s.add(`${name}|${dt.split(' ')[0]}`);
  });
  return s;
}

// --- билеты/пригласительные/выручка по мероприятиям организатора ---
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

// --- зал/площадка + время начала из отчёта «События в продаже» (по кабинету целиком) ---
async function soldVenues() {
  const r = await get('/reports/tickets/sold?form');
  const $ = cheerio.load(r.body);
  let venue = '', hall = '';
  const out = {};
  $('table tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length === 1) {
      const t = $(tds[0]).text().replace(/\s+/g, ' ').trim();
      const i = t.indexOf(':');
      venue = i === -1 ? t : t.slice(0, i).trim();
      hall = i === -1 ? '' : t.slice(i + 1).trim();
      return;
    }
    if (tds.length >= 8 && /^\d+$/.test($(tds[0]).text().trim())) {
      const name = $(tds[1]).text().replace(/\s+/g, ' ').trim();
      const dt = $(tds[2]).text().replace(/\s+/g, ' ').trim(); // "DD.MM.YYYY HH:MM"
      const date = dt.split(' ')[0];
      out[`${name}|${date}`] = { venue, hall };
    }
  });
  return out;
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

const fmt = n => n.toLocaleString('ru-RU');
const dstr = d => d === 0 ? ' (0)' : ` (${d > 0 ? '+' : '-'}${fmt(Math.abs(d))})`;
const pct = (cur, prev) => (typeof prev !== 'number' || prev <= 0) ? '' : ` / ${cur - prev >= 0 ? '+' : '-'}${Math.round(Math.abs(cur - prev) / prev * 100)}%`;

(async () => {
  await get('/');
  const cabs = await cities();
  if (!cabs.length) throw new Error('Список кабинетов пуст (кука протухла?)');

  const events = {}; // key -> {name,date,paid,free,venue,hall,cabinet}
  for (const cab of cabs) {
    await get('/city?id=' + cab.id);
    let oids;
    try { oids = await orgs(); } catch (e) { console.error(`Кабинет ${cab.name}: ${e.message}`); continue; }
    if (!oids.length) continue;
    const act = new Set();
    let evs = [];
    for (const oid of oids) {
      (await activeSet(oid)).forEach(x => act.add(x));
      evs = evs.concat(await evData(oid));
    }
    let venues = {};
    try { venues = await soldVenues(); } catch { /* нет данных о зале — не критично */ }
    for (const e of evs) {
      if (/^тест/i.test(e.name)) continue;
      const key = `${e.name}|${e.date}`;
      if (!act.has(key)) continue; // закрытые/архивные — исключаем полностью
      const v = venues[key] || {};
      events[key] = { name: e.name, date: e.date, paid: e.paid, free: e.free, venue: v.venue || '', hall: v.hall || '', cabinet: cab.name };
    }
  }

  const prev = fs.existsSync(SNAP_FILE) ? JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8') || '{}') : {};
  const pe = prev.events || {};
  const pm = prev.months || {};

  const keys = Object.keys(events).sort((a, b) => {
    const da = events[a].date.split('.').reverse().join('');
    const db = events[b].date.split('.').reverse().join('');
    return da.localeCompare(db);
  });

  const todayKey = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const dateStr = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`;

  let onSale = 0, finished = 0, totalPaid = 0, totalFree = 0;
  const blocks = [];
  for (const k of keys) {
    const x = events[k];
    const evKey = x.date.split('.').reverse().join('');
    const isFinished = evKey < todayKey;
    if (isFinished) finished++; else onSale++;
    totalPaid += x.paid; totalFree += x.free;

    const prior = pe[k];
    const d = dstr(x.paid - (prior ? prior.paid : x.paid));
    const p = pct(x.paid, prior ? prior.paid : undefined);
    const statusLine = `${x.cabinet}   ${isFinished ? 'Завершён' : 'В продаже'}`;
    const venueLines = [x.venue, x.hall].filter(Boolean).join('\n');
    const countLine = isFinished
      ? `🏁 ИТОГ: ${fmt(x.paid)}${d}${p}`
      : `🎫 Продано: ${fmt(x.paid)}${d}${p}`;
    blocks.push(
      `${statusLine}\n${venueLines ? venueLines + '\n' : ''}${x.date}\n${countLine}\n🎟️ Пригласительных: ${fmt(x.free)}`
    );
  }

  const header = `📊 ОТЧЁТ ПО ПРОДАЖАМ — неделя от ${dateStr}\n` +
    `В продаже: ${fmt(onSale)} · продано (без пригласительных): ${fmt(totalPaid)} · пригласительных: ${fmt(totalFree)} · завершено: ${fmt(finished)}`;

  // разбиваем на сообщения по ~3500 символов
  let chunk = header;
  const chunks = [];
  for (const b of blocks) {
    if ((chunk + '\n\n' + b).length > 3500) { chunks.push(chunk); chunk = b; }
    else chunk += '\n\n' + b;
  }
  chunks.push(chunk);
  for (const c of chunks) { await tg(c); await new Promise(z => setTimeout(z, 350)); }

  // --- итого по месяцам (с учётом завершённых) ---
  const MN = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const months = {};
  for (const k of keys) {
    const x = events[k];
    const [, mm, yy] = x.date.split('.');
    const mk = `${yy}-${mm}`;
    if (!months[mk]) months[mk] = { y: +yy, m: +mm, paid: 0, free: 0, count: 0 };
    months[mk].paid += x.paid; months[mk].free += x.free; months[mk].count += 1;
  }
  const mkeys = Object.keys(months).sort();
  if (mkeys.length) {
    let msg = `📊 ИТОГО ПО МЕСЯЦАМ (на ${pad(now.getDate())}.${pad(now.getMonth() + 1)})`;
    for (const mk of mkeys) {
      const x = months[mk];
      const po = pm[mk];
      const dp = dstr(x.paid - (po ? po.paid : x.paid));
      const df = dstr(x.free - (po ? po.free : x.free));
      const dc = dstr(x.count - (po ? po.count : x.count));
      msg += `\n\n${MN[x.m]} ${x.y}\n🎫 Продано: ${fmt(x.paid)}${po ? dp : ''}\n🎟️ Пригласительных: ${fmt(x.free)}${po ? df : ''}\n🎪 Мероприятий: ${fmt(x.count)}${po ? dc : ''}`;
    }
    await tg(msg);
  }

  const snapEvents = {};
  for (const k of keys) { const x = events[k]; snapEvents[k] = { paid: x.paid, free: x.free }; }
  const snapMonths = {};
  for (const mk of mkeys) { const x = months[mk]; snapMonths[mk] = { paid: x.paid, free: x.free, count: x.count }; }
  fs.writeFileSync(SNAP_FILE, JSON.stringify({ date: dateStr, events: snapEvents, months: snapMonths }, null, 2));
  console.log(`OK: кабинетов ${cabs.length}, мероприятий ${keys.length} (в продаже ${onSale}, завершено ${finished})`);
})().catch(e => { console.error(e.message || e); process.exit(1); });
