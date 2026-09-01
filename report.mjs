// Миксмастер — ежедневный отчёт продаж по месяцам → Telegram
// Работает на GitHub Actions (без участия Mac). Авторизация в Яндекс.Билеты — через куку сессии (секрет YANDEX_COOKIE).
// Node 20+ (глобальный fetch). Зависимость: cheerio.
//
// Логика месяца: пока месяц идёт (1–30/31 число) — суммы в его строке считаются по ВСЕМ мероприятиям
// месяца, включая уже прошедшие/закрытые (иначе цифры «теряются» по мере того как концерты закрываются).
// В 1-й день нового месяца — отдельным разовым сообщением уходит окончательный итог по только что
// закончившемуся месяцу, и дальше этот месяц из отчёта пропадает — остаются только текущий и будущие.

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
// ВАЖНО: res.headers.get('set-cookie') в Node/undici при НЕСКОЛЬКИХ Set-Cookie-заголовках
// (а /city?id=... шлёт сразу несколько — сессионную и куку выбранного кабинета) склеивает их
// через запятую в одну строку. Даты вида "Expires=Wdy, DD-Mon-YYYY" сами содержат запятую,
// поэтому наивный split(',') ломает разбор и в итоге куку кабинета иногда теряет/портит —
// из-за этого запросы уходили не в тот кабинет. Правильный способ — getSetCookie(),
// которая отдаёт каждый Set-Cookie отдельной строкой без склейки.
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
// предыдущий календарный месяц — нужен, чтобы 1-го числа собрать по нему окончательный итог
const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const prevKey = `${prevDate.getFullYear()}-${pad(prevDate.getMonth() + 1)}`;
// период запроса: с 1-го числа ПРЕДЫДУЩЕГО месяца (чтобы всегда иметь под рукой данные для закрывающего
// сообщения 1-го числа) и на 400 дней вперёд
const FROM = `01.${pad(prevDate.getMonth() + 1)}.${prevDate.getFullYear()}`;
const t2 = new Date(now.getTime() + 400 * 864e5);
const TO = `${pad(t2.getDate())}.${pad(t2.getMonth() + 1)}.${t2.getFullYear()}`;

async function orgs() {
  const r = await get('/repertoire/organizers/');
  if (looksLikeLogin(r)) throw new Error('AUTH_FAILED: не залогинен (organizers)');
  const $ = cheerio.load(r.body);
  const activeOpt = $('select.js-city-select option[selected]');
  console.error(`[debug] active cabinet per select#js-city-select: value=${activeOpt.attr('value') || 'NOT FOUND'} text="${activeOpt.text().trim()}" (expected ${CAB})`);
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

// ext=0: по одной строке на мероприятие — Событие/Дата/Статус/Получено/Свободно/.../Продано/...
// Нужен, чтобы отличить «запущено (и, возможно, уже завершилось)» от «посчитано, но так и не
// запущено в продажу» — оба варианта дают статус «закрыто», различаются только тем, выпускались
// ли когда-либо билеты в свободную продажу.
async function evStatus(oid) {
  const r = await get(`/reports/tickets/organizer?report=1&event_date_from=${FROM}&event_date_to=${TO}&organizer_id=${oid}&ext=0`);
  if (looksLikeLogin(r)) throw new Error('AUTH_FAILED: не залогинен (ext=0)');
  const $ = cheerio.load(r.body);
  const out = [];
  $('table tr').each((_, tr) => {
    const c = $(tr).find('td,th');
    if (c.length < 15) return; // короче настоящей строки данных (19 колонок) — это шапка
    const v = c.map((i, el) => $(el).text().replace(/\s+/g, ' ').trim()).get();
    const dm = (v[1] || '').match(/^(\d{2}\.\d{2}\.\d{4})/);
    if (!dm) return;
    out.push({
      name: v[0],
      date: dm[1],
      status: v[2] || '',                                   // '' = на продаже, иначе закрыто/отменено
      sold: parseInt((v[13] || '0').replace(/[^\d]/g, '')) || 0,   // «Продано», билетов
      avail: parseInt((v[5] || '0').replace(/[^\d]/g, '')) || 0,   // «Свободно», билетов
    });
  });
  return out;
}

async function tg(text) {
  if ((process.env.DRY_RUN || '') === '1') {
    console.error('[debug] DRY_RUN — сообщение НЕ отправлено:\n' + text);
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

(async () => {
  console.error(`[debug] now=${new Date().toISOString()} curKey=${curKey} prevKey=${prevKey} FROM=${FROM} TO=${TO}`);
  await get('/city?id=' + CAB);
  const os = await orgs();
  console.error(`[debug] organizers: ${JSON.stringify(os)}`);
  if (!os.length) throw new Error('Организаторы кабинета не найдены (кука протухла или кабинет пуст)');
  let evs = [];
  for (const oid of os) {
    const statusRows = await evStatus(oid);
    const revMap = {};
    const evDataRows = await evData(oid);
    for (const e of evDataRows) revMap[`${e.name}|${e.date}`] = e;
    console.error(`[debug] org ${oid}: statusRows=${statusRows.length} evDataRows=${evDataRows.length}`);
    let kept = 0, skippedTest = 0, skippedNeverLaunched = 0;
    for (const s of statusRows) {
      if (/^тест/i.test(s.name)) { skippedTest++; continue; }
      if (/отмена/i.test(s.name)) { skippedTest++; continue; }
      // «закрыто», но билеты никогда не были выпущены в свободную продажу (Продано=0 и Свободно=0) —
      // значит мероприятие было только просчитано внутри, но так и не запущено. Не считаем его.
      if (s.status && s.sold === 0 && s.avail === 0) { skippedNeverLaunched++; continue; }
      const rv = revMap[`${s.name}|${s.date}`] || { paid: 0, free: 0, rev: 0 };
      evs.push({ name: s.name, date: s.date, paid: rv.paid, free: rv.free, rev: rv.rev });
      kept++;
    }
    console.error(`[debug] org ${oid}: kept=${kept} skippedTest=${skippedTest} skippedNeverLaunched=${skippedNeverLaunched}`);
  }
  console.error(`[debug] total evs kept: ${evs.length}`);

  const MN = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  // Считаем по ВСЕМ ЗАПУЩЕННЫМ мероприятиям месяца — включая уже прошедшие/закрытые (иначе цифры
  // «теряются» по мере завершения концертов). Мероприятия, которые были только просчитаны, но не
  // запущены в продажу, уже отфильтрованы выше (по статусу+Продано+Свободно из ext=0).
  const months = {};
  for (const e of evs) {
    const [, mm, yy] = e.date.split('.');
    const key = `${yy}-${mm}`;
    if (key < prevKey) continue; // всё раньше предыдущего месяца — не нужно
    if (!months[key]) months[key] = { y: +yy, m: +mm, paid: 0, free: 0, rev: 0, count: 0 };
    months[key].paid += e.paid; months[key].free += e.free; months[key].rev += e.rev;
    months[key].count += 1;
  }
  console.error(`[debug] months: ${JSON.stringify(Object.fromEntries(Object.entries(months).map(([k,v])=>[k,{count:v.count,paid:v.paid,rev:v.rev}])))}`);

  const prev = fs.existsSync(SNAP_FILE) ? JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8') || '{}') : {};
  const pm = prev.months || null;
  const fmt = n => n.toLocaleString('ru-RU');
  const dstr = d => d === 0 ? ' (0)' : ` (${d > 0 ? '+' : '-'}${fmt(Math.abs(d))})`;
  const dl = (k, field, cur) => (!pm || !pm[k] || typeof pm[k][field] !== 'number') ? '' : dstr(cur - pm[k][field]);
  const dateStr = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}`;

  // 1-го числа месяца — окончательный итог по только что закончившемуся месяцу, одним сообщением
  // (если по месяцу вообще не было продаж — не шлём пустое сообщение)
  if (now.getDate() === 1 && months[prevKey] && (months[prevKey].paid || months[prevKey].free)) {
    const x = months[prevKey];
    const avg = x.paid ? Math.round(x.rev / x.paid) : 0;
    let avgd = '';
    if (pm && pm[prevKey] && pm[prevKey].paid) avgd = dstr(avg - Math.round(pm[prevKey].rev / pm[prevKey].paid));
    const msg =
      `📊 Миксмастер · ${MN[x.m]} ${x.y} — ИТОГИ МЕСЯЦА\n` +
      `💰 Сумма: ${fmt(x.rev)} р.${dl(prevKey, 'rev', x.rev)}\n` +
      `🎫 Билетов: ${fmt(x.paid)}${dl(prevKey, 'paid', x.paid)}\n` +
      `🎟️ Пригл.: ${fmt(x.free)}${dl(prevKey, 'free', x.free)}\n` +
      `🎪 Мероприятий: ${fmt(x.count)}${dl(prevKey, 'count', x.count)}\n` +
      `🏛️ Ср.чек: ${fmt(avg)} р.${avgd}`;
    await tg(msg);
    await new Promise(z => setTimeout(z, 350));
  }

  // дальше — только текущий и будущие месяцы
  const keys = Object.keys(months).filter(k => k >= curKey).sort();

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
        if (k < curKey) continue; // прошлые месяцы в сравнение ИТОГО не тянем
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
  if ((process.env.DRY_RUN || '') === '1') {
    console.error('[debug] DRY_RUN — snapshot.json НЕ перезаписан');
  } else {
    fs.writeFileSync(SNAP_FILE, JSON.stringify(snap, null, 2));
  }
  console.log(`OK: отправлено месяцев ${keys.length}${keys.length ? ' + итого' : ''}${(now.getDate() === 1 && months[prevKey]) ? ' + итоги прошлого месяца' : ''}`);
})().catch(e => { console.error(e.message || e); process.exit(1); });
