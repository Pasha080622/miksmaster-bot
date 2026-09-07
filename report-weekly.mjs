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

// --- единый cookie-jar ---
// ВАЖНО (тот же баг, что чинили в report.mjs 01.09): res.headers.get('set-cookie') в Node/undici
// при НЕСКОЛЬКИХ Set-Cookie-заголовках склеивает их через запятую, а даты вида
// "Expires=Wdy, DD-Mon-YYYY" сами содержат запятую — наивный split(',') ломает разбор и теряет/портит
// куку кабинета. Из-за этого прошлая попытка еженедельного отчёта видела события только у 1 из 18
// кабинетов (переключение /city?id=X реально срабатывало только для последнего кабинета в цикле).
// Правильный способ — getSetCookie(), которая отдаёт каждый Set-Cookie отдельной строкой без склейки.
let cookie = COOKIE;
function mergeSetCookie(res) {
  let parts;
  if (typeof res.headers.getSetCookie === 'function') {
    parts = res.headers.getSetCookie();
  } else {
    const sc = res.headers.get('set-cookie');
    parts = sc ? sc.split(/,(?=[^ ;]+=)/) : [];
  }
  for (const part of parts) {
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

// --- Город по площадке (реальные данные, а не по названию кабинета) ---
// У каждой площадки в разделе «Репертуар → Залы» (/halls/) есть собственное поле «Город»
// (плюс адрес/координаты на карте) — это и есть настоящий источник города, который ведёт сама
// площадка/менеджер при заведении зала, а не догадка по названию юрлица-кабинета (кабинет может
// обслуживать площадки в разных городах, и наоборот — некоторые названия площадок неоднозначны,
// напр. просто «Руки Вверх! Бар» без города в названии). /halls/ — список — рендерится на клиенте
// без city в HTML, но есть рабочий постраничный поиск `/halls/?_q=<название>` (см. ниже), который
// отдаёт обычный серверный HTML с строками `<a href="edit?id=ID" class="js-venue-item">Название</a>`;
// а сама страница `/halls/edit?id=ID` уже отдаёт «Город» открытым текстом в <span>. Результаты
// кешируются в venue-city-cache.json, чтобы не дёргать /halls/ на каждый запуск ради одних и тех же
// ~60-90 площадок недели.
const VENUE_CACHE_FILE = 'venue-city-cache.json';
let venueCityCache = {};
try { venueCityCache = JSON.parse(fs.readFileSync(VENUE_CACHE_FILE, 'utf8')); } catch { /* нет файла — начнём с пустого */ }
let venueCacheDirty = false;

// В CMS у Павла встречаются залы-дубли: несколько записей с ОДИНАКОВЫМ названием площадки,
// но разными id и разными городами (напр. «Руки Вверх! Бар» — сразу 3 таких записи). По одному
// названию их не различить, поэтому если совпадений несколько и города расходятся — город
// оставляем пустым (лучше пусто, чем неверно) и запоминаем площадку в ambiguousVenues, чтобы
// вывести список Павлу для ручной проверки/переименования дублей в CMS.
const ambiguousVenues = [];

async function fetchVenueCity(venueName) {
  if (!venueName) return '';
  if (Object.prototype.hasOwnProperty.call(venueCityCache, venueName)) return venueCityCache[venueName];
  let city = '';
  try {
    const r = await get(`/halls/?_q=${encodeURIComponent(venueName)}`);
    const re = /href="edit\?id=(\d+)" class="js-venue-item"[^>]*>([^<]*)<\/a>/g;
    let m;
    const ids = [];
    while ((m = re.exec(r.body))) {
      if (m[2].trim() === venueName) ids.push(m[1]); // точное совпадение названия — таких может быть несколько (дубли в CMS)
    }
    const cities = new Set();
    for (const id of ids) {
      const r2 = await get(`/halls/edit?id=${id}`);
      const cm = r2.body.match(/Город<\/label>\s*<div[^>]*>\s*<span>([^<]*)<\/span>/);
      if (cm && cm[1].trim()) cities.add(cm[1].trim());
    }
    if (cities.size === 1) {
      city = [...cities][0];
    } else if (cities.size > 1) {
      city = '';
      ambiguousVenues.push({ venue: venueName, cities: [...cities] });
    }
  } catch { /* сеть подвела — не критично, город останется пустым в этот раз */ }
  venueCityCache[venueName] = city;
  venueCacheDirty = true;
  return city;
}

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
  if ((process.env.DRY_RUN || '') === '1') {
    console.error('[debug] DRY_RUN — сообщение НЕ отправлено (' + text.length + ' симв.):\n' + text);
    return;
  }
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
// Дельта+% ОДНОЙ скобкой, как в реальном отчёте: "94 (+20 / +27%)", "17 (+17 с нуля)", "0 (0)".
// prior === undefined — истории по этому событию ещё нет (первое появление в отчёте) →
// показываем «(новое)», а не пустоту — так «0 (новое)» и «0 (0)» всегда различимы.
function deltaStr(cur, prior) {
  if (typeof prior !== 'number') return ' (новое)';
  const d = cur - prior;
  if (d === 0) return ' (0)';
  const sign = d > 0 ? '+' : '-';
  let s = ` (${sign}${fmt(Math.abs(d))}`;
  if (prior > 0) s += ` / ${sign}${Math.round(Math.abs(d) / prior * 100)}%`;
  else if (cur > 0) s += ' с нуля';
  return s + ')';
}

(async () => {
  await get('/');
  const cabs = await cities();
  if (!cabs.length) throw new Error('Список кабинетов пуст (кука протухла?)');

  const events = {}; // key -> {name,date,paid,free,venue,hall,cabinet}
  for (const cab of cabs) {
    await get('/city?id=' + cab.id);
    let oids;
    try { oids = await orgs(); } catch (e) { console.error(`Кабинет ${cab.name}: ${e.message}`); continue; }
    if (!oids.length) { console.error(`[debug] кабинет ${cab.id} ${cab.name}: организаторов нет`); continue; }
    const act = new Set();
    let evs = [];
    for (const oid of oids) {
      (await activeSet(oid)).forEach(x => act.add(x));
      evs = evs.concat(await evData(oid));
    }
    let venues = {};
    try { venues = await soldVenues(); } catch { /* нет данных о зале — не критично */ }
    let keptForCab = 0;
    for (const e of evs) {
      if (/^тест/i.test(e.name)) continue;
      if (/отмена/i.test(e.name)) continue;
      const key = `${e.name}|${e.date}`;
      // Раньше здесь стояло `if (!act.has(key)) continue;` — оно выбрасывало ЗАКРЫТЫЕ/архивные
      // мероприятия целиком, хотя evData() (ext=1) их уже отдаёт с финальными цифрами продаж.
      // Из-за этого завершённые концерты вообще никогда не попадали в отчёт. Теперь оставляем
      // все события из evData, а через act.has(key) только помечаем «завершено/в продаже».
      const v = venues[key] || {};
      const city = await fetchVenueCity(v.venue);
      events[key] = {
        name: e.name, date: e.date, paid: e.paid, free: e.free,
        venue: v.venue || '', hall: v.hall || '', cabinet: cab.name,
        city, active: act.has(key),
      };
      keptForCab++;
    }
    console.error(`[debug] кабинет ${cab.id} ${cab.name}: организаторов=${oids.length} activeSet=${act.size} evData=${evs.length} принято=${keptForCab}`);
  }

  const prev = fs.existsSync(SNAP_FILE) ? JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8') || '{}') : {};
  const pe = prev.events || {};
  const pm = prev.months || {};

  const todayKey = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const dateStr = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`;

  // Кроме реально завершённых/идущих в продаже событий, evData() (ext=1) отдаёт и «черновики» —
  // мероприятия, которые CMS ещё не выставила на продажу (не входят в activeSet, дата в будущем,
  // 0 продано, без площадки — soldVenues() по ним банер не строит, поэтому venue/city всегда пустые).
  // Раньше они молча выбрасывались через `if (!act.has(key)) continue;`; при переходе на «показывать
  // завершённые» это привело к тому, что такие черновики тоже стали помечаться «Завершён, ИТОГ: 0» —
  // что неверно: они не «завершились», их просто ещё не запускали. Оставляем в отчёте только события,
  // у которых либо дата уже прошла, либо они сейчас реально в продаже (act.has) — как и раньше для
  // черновиков, но больше НЕ выбрасываем прошедшие события, у которых просто закрылись продажи.
  const keys = Object.keys(events).filter(k => {
    const x = events[k];
    const evKey = x.date.split('.').reverse().join('');
    return x.active || evKey < todayKey;
  }).sort((a, b) => {
    const da = events[a].date.split('.').reverse().join('');
    const db = events[b].date.split('.').reverse().join('');
    return da.localeCompare(db);
  });

  let onSale = 0, finished = 0, totalPaid = 0, totalFree = 0;
  const blocks = [];
  for (const k of keys) {
    const x = events[k];
    // «Завершено» определяем по самому CMS (x.active из activeSet — непустая колонка статуса =
    // закрыто/архив) ИЛИ по дате в прошлом — этого достаточно, т.к. черновики без даты в прошлом
    // и без active уже отфильтрованы выше.
    const evKey = x.date.split('.').reverse().join('');
    const isFinished = !x.active || evKey < todayKey;
    if (isFinished) finished++; else onSale++;
    totalPaid += x.paid; totalFree += x.free;

    const prior = pe[k];
    const d = deltaStr(x.paid, prior ? prior.paid : undefined);

    // Завершённые мероприятия показываем В СООБЩЕНИИ только ОДИН раз — в ту неделю, когда они
    // впервые стали «Завершён» (как раньше в старом скрипте). В снапшоте помечаем reported:true,
    // и на следующих неделях такое событие уже не попадает в blocks (но продолжает учитываться
    // в шапке/итогах по месяцам, пока остаётся в текущем окне FROM..TO).
    const alreadyReported = !!(prior && prior.reported);
    if (isFinished && alreadyReported) continue;

    const statusLine = `${x.name}   ${isFinished ? 'Завершён' : 'В продаже'}`;
    const cityLine = x.city ? `${x.city}\n` : '';
    // x.hall — это описание рассадки/зоны продаж («ТП + столы»), а не город/зал — в реальном
    // отчёте такого нет, поэтому в сообщение идёт только название площадки.
    const countLine = isFinished
      ? `🏁 ИТОГ: ${fmt(x.paid)}${d}`
      : `${fmt(x.paid)}${d}`;
    const freeLine = x.free ? `\n🎟️ Пригласительных: ${fmt(x.free)}` : '';
    blocks.push(
      `${statusLine}\n${cityLine}${x.venue ? x.venue + '\n' : ''}${x.date}\n${countLine}${freeLine}`
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

  // Сообщение «ИТОГО ПО МЕСЯЦАМ» убрано по просьбе пользователя (не нужно) — 07.09.
  const snapEvents = {};
  for (const k of keys) {
    const x = events[k];
    const evKey = x.date.split('.').reverse().join('');
    const isFinished = !x.active || evKey < todayKey;
    // reported:true — событие уже завершено (независимо от того, показывали ли мы его в блоках
    // именно сегодня, или оно уже было показано раньше) — так следующая неделя его не покажет.
    snapEvents[k] = { paid: x.paid, free: x.free, reported: isFinished };
  }
  if ((process.env.DRY_RUN || '') === '1') {
    console.error('[debug] DRY_RUN — snapshot-weekly.json НЕ перезаписан');
  } else {
    fs.writeFileSync(SNAP_FILE, JSON.stringify({ date: dateStr, events: snapEvents }, null, 2));
  }
  // Кеш города по площадкам обновляем всегда (даже в DRY_RUN) — он не влияет на текст отчёта
  // и на дельты между неделями, только экономит запросы к /halls/ в следующий раз.
  if (venueCacheDirty) {
    try { fs.writeFileSync(VENUE_CACHE_FILE, JSON.stringify(venueCityCache, null, 2)); }
    catch (e) { console.error('[debug] не удалось сохранить venue-city-cache.json:', e.message || e); }
  }
  // Площадки-дубли (одинаковое название, разные города в CMS) — город не показан, т.к. не различить.
  // Список — только в лог, Павлу для ручной проверки/переименования дублей в разделе «Залы».
  if (ambiguousVenues.length) {
    console.error('[warn] город не определён однозначно (в CMS несколько залов с одинаковым названием, но разными городами):');
    for (const a of ambiguousVenues) console.error(`  - "${a.venue}": ${a.cities.join(' / ')}`);
  }
  console.log(`OK: кабинетов ${cabs.length}, мероприятий ${keys.length} (в продаже ${onSale}, завершено ${finished})`);
})().catch(e => { console.error(e.message || e); process.exit(1); });
