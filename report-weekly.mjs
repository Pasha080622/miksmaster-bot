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
//
// ВАЖНО (баг найден 26.09 по жалобе Павла — «Руки Вверх! Бар» в отчёте показывал Ярославль для
// событий, которые реально шли в Перми/Екатеринбурге): сеть «Руки Вверх! Бар» — это МНОЖЕСТВО
// разных кабинетов (юрлиц), по одному на город, и у КАЖДОГО в /halls/ может быть СВОЙ зал с БУКВАЛЬНО
// одинаковым названием «Руки Вверх! Бар» (без города в названии — в отличие от «Руки Вверх! Бар
// Таганка» и т.п., которые этой проблеме не подвержены). Поиск `/halls/?_q=` при этом всегда видит
// только зал ТЕКУЩЕГО активного кабинета — сам по себе не путает города. Но кэш ниже был ключом
// ТОЛЬКО по названию площадки, без привязки к кабинету — поэтому первый же кабинет с залом
// «Руки Вверх! Бар» (по порядку обхода cabs) записывал в кэш «Руки Вверх! Бар → <свой город>», и
// этот же (уже чужой) город молча подставлялся ВСЕМ остальным кабинетам с залом того же названия —
// без единого предупреждения, т.к. каждый отдельный `/halls/?_q=` запрос видел только «свой» зал
// и не подозревал о дублях в других кабинетах. Фикс — ключ кэша теперь пара (id кабинета + название
// площадки), а не одно название; см. fetchVenueCity() ниже.
const VENUE_CACHE_FILE = 'venue-city-cache.json';
let venueCityCache = {};
try { venueCityCache = JSON.parse(fs.readFileSync(VENUE_CACHE_FILE, 'utf8')); } catch { /* нет файла — начнём с пустого */ }
// Старые записи (до фикса от 26.09) были ключом просто по названию площадки, без кабинета — такой
// кэш мог содержать «отравленные» между кабинетами города (см. комментарий выше) и с новым форматом
// ключа `${cabinetId}|${venueName}` всё равно не совпадёт ни с одним новым ключом, так что технически
// не мешал бы. Но на всякий случай выбрасываем такие ключи явно (ключ без «|» = старый формат), чтобы
// файл не тащил в себе неиспользуемый мусор.
for (const k of Object.keys(venueCityCache)) {
  if (!k.includes('|')) delete venueCityCache[k];
}
let venueCacheDirty = false;

// В CMS у Павла встречаются залы-дубли: несколько записей с ОДИНАКОВЫМ названием площадки,
// но разными id и разными городами (напр. «Руки Вверх! Бар» — сразу 3 таких записи). По одному
// названию их через /halls/ не различить. В этом случае пробуем второй источник, который прямо
// просил Павел — комментарий у карточки «Мероприятие» в разделе «Репертуар → Мероприятия»
// (/repertoire/activities/): там для каждого конкретного показа обычно указан город и/или зал
// (напр. «Волгоград / Kultura concert hall», «Рязань / РВБ»). Формат комментария не унифицирован
// (иногда «Город / Зал», иногда «Зал ГОРОД» одним словом без разделителя, иногда порядок обратный —
// «Тур/Город»), поэтому его структуру не парсим, а просто проверяем, встречается ли в тексте ровно
// ОДИН из городов-кандидатов дублирующихся залов; если совпал ровно один — берём его, если ни
// одного или несколько — город остаётся пустым (лучше пусто, чем неверно), а площадка попадает
// в ambiguousVenues, чтобы вывести список Павлу для ручной проверки/переименования дублей в CMS.
const ambiguousVenues = [];
const activitiesCache = {}; // id кабинета -> [{name, comment}] (Репертуар → Мероприятия)

async function fetchActivities(cabinetId) {
  if (activitiesCache[cabinetId]) return activitiesCache[cabinetId];
  const rows = [];
  for (let page = 1; page <= 12; page++) {
    let r;
    try { r = await get(`/repertoire/activities/?page=${page}`); } catch { break; }
    const $ = cheerio.load(r.body);
    let found = 0;
    $('table tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length >= 2) {
        const name = $(tds[0]).text().replace(/\s+/g, ' ').trim();
        const comment = $(tds[1]).text().replace(/\s+/g, ' ').trim();
        if (name) { rows.push({ name, comment }); found++; }
      }
    });
    if (found < 25) break; // страница неполная — дальше страниц нет
  }
  activitiesCache[cabinetId] = rows;
  return rows;
}

async function disambiguateByComment(cabinetId, eventName, candidateCities) {
  try {
    const rows = await fetchActivities(cabinetId);
    for (const r of rows) {
      if (r.name !== eventName || !r.comment) continue;
      const hit = candidateCities.filter((c) => r.comment.includes(c));
      if (hit.length === 1) return hit[0];
    }
  } catch { /* сеть подвела — не критично, город останется пустым */ }
  return '';
}

// Возвращает { city, candidates } — city заполнен, если город однозначен; иначе candidates —
// список городов-кандидатов (площадка-дубль), которые может попробовать разрешить вызывающий код
// через disambiguateByComment (для этого нужны кабинет и название мероприятия — их знает только
// основной цикл, а не эта функция, поэтому окончательное решение принимается там).
async function fetchVenueCity(cabinetId, venueName) {
  if (!venueName) return { city: '', candidates: [] };
  // Ключ кэша — ОБЯЗАТЕЛЬНО кабинет+площадка, а не одна площадка (см. комментарий выше):
  // `/halls/?_q=` физически ищет только среди залов ТЕКУЩЕГО активного кабинета, так что один и тот
  // же ключ-строка «Руки Вверх! Бар» в разных кабинетах — это РАЗНЫЕ залы с разными городами.
  const cacheKey = `${cabinetId}|${venueName}`;
  if (Object.prototype.hasOwnProperty.call(venueCityCache, cacheKey)) {
    const cached = venueCityCache[cacheKey];
    return typeof cached === 'string' ? { city: cached, candidates: [] } : cached;
  }
  const result = { city: '', candidates: [] };
  try {
    // НАЙДЕНО 14.09 (Павел показал зал id=54173154 «Руки Вверх! Бар (Иваново)» — там прямо в
    // карточке видно «Город: Иваново», и он справедливо спросил, почему скрипт всё равно не смог
    // определить город). Разобрался — две отдельные ошибки в этой функции:
    //
    // 1) /halls/?_q= — результат постраничный (по 25 штук), а мы читали только 1-ю страницу. У
    //    Павла в кабинете «ООО МИКСМАСТЕР (УК)» под запрос «Руки Вверх! Бар» попадает 33 зала —
    //    3-й странице ничего не гарантировано, часть залов просто не долетала до кода.
    // 2) Ссылка на зал в списке результатов показывает «Сокращённое название» (name_short_ru), а
    //    не «Название» (name_ru) — и у части залов эти два поля заведены по-разному: например,
    //    у ивановского «Руки Вверх! Бар» Название = "Руки Вверх! Бар" (точно как баннер в отчёте
    //    о продажах), а Сокращённое название = "Руки Вверх! Бар (Иваново)". Старое сравнение
    //    `m[2].trim() === venueName` сверяло venueName именно с Сокращённым названием — поэтому
    //    ивановский зал молча отбрасывался как «не совпадающий», а вместо него подбирались 3
    //    случайных других зала (Новосибирск×2, Волгоград), у которых как раз Сокращённое название
    //    пустое/бэйр. Теперь: (а) читаем все страницы поиска, (б) для каждого найденного id
    //    сравниваем venueName И с name_ru, И с name_short_ru — совпадение по любому из двух полей
    //    считается совпадением.
    //
    // НАЙДЕНО 14.09, ВТОРОЙ ЗАХОД (после деплоя фикса выше все города вообще пропали, включая
    // ранее верно определявшиеся Линда→Ярославль, Фактор2→Пермь — временная регрессия): сама CMS
    // на `/halls/?_q=...&page=1` (именно с ЯВНЫМ `page=1`) отвечает не HTML-страницей, а HTTP-
    // редиректом (на тот же адрес БЕЗ параметра page) — проверено напрямую через fetch с
    // `redirect:'manual'`, как в этом скрипте: `page=1` в URL → opaqueredirect, тело пустое;
    // без `page` вовсе или `page=2,3,...` → 200 с обычным HTML. get() в этом файле всегда
    // использует `redirect:'manual'` (это нужно в других местах, чтобы ловить редирект на логин),
    // поэтому редирект с 1-й страницы НЕ разворачивался, r.body был пустым, регэксп не находил ни
    // одного id — и так для КАЖДОЙ площадки без исключения (город/кандидаты оставались пустыми
    // молча, без единой ошибки в логе). Фикс: 1-ю страницу запрашиваем БЕЗ параметра `page` вообще
    // (как исходно и работало), а `&page=N` добавляем только начиная со 2-й.
    const ids = [];
    for (let page = 1; page <= 6; page++) {
      const path = page === 1
        ? `/halls/?_q=${encodeURIComponent(venueName)}`
        : `/halls/?_q=${encodeURIComponent(venueName)}&page=${page}`;
      const r = await get(path);
      const re = /href="edit\?id=(\d+)" class="js-venue-item"[^>]*>/g;
      let m;
      let found = 0;
      while ((m = re.exec(r.body))) { ids.push(m[1]); found++; }
      if (found < 25) break; // последняя страница
    }
    const cities = new Set();
    for (const id of ids) {
      const r2 = await get(`/halls/edit?id=${id}`);
      const nameM = r2.body.match(/name="name_ru"[^>]*value="([^"]*)"/);
      const shortM = r2.body.match(/name="name_short_ru"[^>]*value="([^"]*)"/);
      const matches = (nameM && nameM[1].trim() === venueName) || (shortM && shortM[1].trim() === venueName);
      if (!matches) continue;
      const cm = r2.body.match(/Город<\/label>\s*<div[^>]*>\s*<span>([^<]*)<\/span>/);
      if (cm && cm[1].trim()) cities.add(cm[1].trim());
    }
    if (cities.size === 1) result.city = [...cities][0];
    else if (cities.size > 1) result.candidates = [...cities];
  } catch { /* сеть подвела — не критично, город останется пустым в этот раз */ }
  venueCityCache[cacheKey] = result;
  venueCacheDirty = true;
  return result;
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
// ВАЖНО (найдено 07.09 по жалобе Павла): одно и то же название мероприятия может идти НЕСКОЛЬКО
// РАЗ в один день в разное время (напр. «Моя Мишель» 26.09.2026 в 19:00 и в 19:30 — это два разных
// показа). Ключ «имя|дата» без времени схлопывал их в одну запись, и один из показов молча пропадал
// или получал чужие цифры. Поэтому ключ везде (здесь, в evData и soldVenues) строится как
// «имя|дата|время», а не «имя|дата».
// Возвращает { active, ids }: active — как раньше, множество ключей «в продаже» (не закрыто/архив);
// ids — карта ключ → [event_id,...], собранная из ссылки /repertoire/events/edit?id=N в 1-й колонке
// (нужна, чтобы потом дёрнуть отчёт «по секторам» — см. sectorCategoryTotals). Собираем id ПО ВСЕМ
// строкам (не только «активным») — так же, как evData() (ext=1) суммирует продажи по ключу без
// разбора статуса, чтобы разбивка по категориям била ровно в тот же 🎫-итог.
async function activeSet(oid) {
  const r = await get(`/reports/tickets/organizer?report=1&event_date_from=${FROM}&event_date_to=${TO}&organizer_id=${oid}&ext=0`);
  if (looksLikeLogin(r)) throw new Error('AUTH_FAILED: не залогинен (ext=0)');
  const $ = cheerio.load(r.body);
  const s = new Set();
  const ids = {};
  $('table tr').each((_, tr) => {
    const c = $(tr).find('td');
    if (c.length < 15) return;
    const dt = $(c[1]).text().trim();
    if (!/^\d{2}\.\d{2}\.\d{4}/.test(dt)) return;
    const name = $(c[0]).text().replace(/\s+/g, ' ').trim();
    const [date, time] = dt.split(' ');
    const key = `${name}|${date}|${time || ''}`;
    if ($(c[2]).text().trim() === '') s.add(key); // непустая колонка = закрыто/архив
    const href = $(c[0]).find('a').attr('href') || '';
    const m = href.match(/id=(\d+)/);
    if (m) (ids[key] || (ids[key] = [])).push(m[1]);
  });
  return { active: s, ids };
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
      const m = t.match(/^(.*)\((\d{2}\.\d{2}\.\d{4})(?:\s+(\d{2}:\d{2}))?[^)]*\)\s*$/);
      cur = m ? { name: m[1].trim(), date: m[2], time: m[3] || '' } : null;
      return;
    }
    if (c.length === 17 && cur) {
      const v = c.map((i, el) => $(el).text().replace(/\s+/g, ' ').trim()).get();
      if (v[0] === '') return;
      const price = parseFloat(v[0].replace(/\s+/g, '')) || 0;
      const bil = parseInt(v[11].replace(/[^\d]/g, '')) || 0;
      const sum = parseInt(v[12].replace(/[^\d]/g, '')) || 0;
      const k = `${cur.name}|${cur.date}|${cur.time}`;
      if (!acc[k]) acc[k] = { name: cur.name, date: cur.date, time: cur.time, paid: 0, free: 0, rev: 0 };
      if (price > 0) { acc[k].paid += bil; acc[k].rev += sum; } else acc[k].free += bil;
    }
  });
  return Object.values(acc);
}

// --- разбивка продаж по секторам для ОДНОГО конкретного «Событие» (event_id) ---
// Найдено 14.09 по показу Павла: кабинет → Отчеты → Билеты → «По событию» → конкретное событие →
// Детализация «По секторам» — это отдельная форма /reports/tickets/event?form, а сам отчёт (как и
// у «По событию»/organizer) строится GET-запросом report=1&event_id=<id>&ext=1 (ext=1 = «По секторам»,
// см. <select name="ext"> в форме: 0=Общий отчёт, 1=По секторам, 2=По агентам, ...). В отличие от
// уже использовавшегося /reports/tickets/organizer?...&ext=1 (там «ext=1» — просто расширенные
// столбцы БЕЗ названия сектора, только цена), здесь одна HTML-таблица явно группирует строки по
// сектору: строка-заголовок сектора (1 ячейка, текст — «VIP 2», «Танцпол», «Столы», «Балкон. Левая
// сторона» и т.п.), затем 1+ строк по ценовым градациям этого сектора (1-я ячейка — цена, непустая),
// затем строка-подытог сектора (1-я ячейка ПУСТАЯ, остальные — суммы по всем ценам сектора), затем
// пустая строка-разделитель. В самом конце таблицы — ОБЩИЙ итог по событию (тоже 1-я ячейка пустая),
// но перед ним уже нет строки-заголовка сектора — поэтому отличаем «подытог сектора» от «общего
// итога» состоянием curSector: сразу после того как забрали подытог текущего сектора (см. ниже —
// подытог теперь считаем сами, а не берём готовую строку), обнуляем curSector, и следующая строка
// с пустой 1-й ячейкой (это и есть общий итог) уже не попадёт в разбивку. Колонки те же, что и у
// /organizer: Цена | Получено | Возвращено квоты | Свободно | Забронировано | У агента | В абонементе |
// Продано | Скидка | Возвращено | ИТОГО — каждая (кроме Цены) в 2 столбца (Билетов, Сумма). «Продано» —
// 7-я по счёту пара после Цены, т.е. индексы 13(Билетов) и 14(Сумма) в плоском массиве ячеек строки.
//
// НАЙДЕНО 14.09 при первом же тестовом прогоне (Леша Свик 25.10.2026, Тверская): 🎫-итог (52,
// как и раньше считает evData() — «Продано» ТОЛЬКО по ценовым строкам с ценой > 0) разошёлся с суммой
// категорий (получалось 105!). Причина — строка-подытог сектора в отчёте «по секторам» суммирует
// «Продано» ПО ВСЕМ ценовым градациям сектора, включая цену=0 (пригласительные/бесплатные — они же
// отдельно уже показаны в строке «🎟️ Пригласительных», которая берётся из evData()/organizer-отчёта).
// Раньше sectorCategoryTotals() брал именно эту готовую строку-подытог — из-за чего пригласительные
// задваивались (считались и в 🎟️, и внутри 💃/🪑). Фикс — подытог сектора теперь считаем САМИ, суммируя
// «Продано» только по ценовым строкам с ценой > 0 (строку с ценой = 0 просто пропускаем), а не берём
// готовую строку-подытог из HTML — так сумма категорий бьётся в тот же 🎫, что и раньше.
async function sectorCategoryTotals(eventId) {
  const r = await get(`/reports/tickets/event?report=1&event_id=${eventId}&ext=1`);
  if (looksLikeLogin(r)) throw new Error('AUTH_FAILED: не залогинен (sector report)');
  const $ = cheerio.load(r.body);
  let curSector = null;
  const acc = {}; // название сектора -> {bil,sum}, только по ценам > 0
  $('table').first().find('tr').each((_, tr) => {
    const c = $(tr).find('td,th');
    if (c.length === 1) {
      const t = $(c[0]).text().replace(/\s+/g, ' ').trim();
      if (t) { curSector = t; if (!acc[curSector]) acc[curSector] = { bil: 0, sum: 0 }; }
      return;
    }
    if (c.length < 2) return;
    const v = c.map((i, el) => $(el).text().replace(/\s+/g, ' ').trim()).get();
    if (v[0] === '') { curSector = null; return; } // строка-подытог сектора ИЛИ общий итог — не сектора, дальше не читаем (curSector уже обнулён)
    if (!curSector) return; // строки до первого заголовка сектора (шапка таблицы) — сюда не попадают, т.к. v[0] у шапки непустой ("Цена"/"Билетов"), но на всякий случай
    const price = parseFloat(v[0].replace(/\s+/g, '')) || 0;
    if (price <= 0) return; // цена 0 — пригласительные, уже учтены отдельно в 🎟️ (evData/free), в категории не включаем
    const bil = parseInt((v[13] || '0').replace(/[^\d-]/g, '')) || 0;
    const sum = parseInt((v[14] || '0').replace(/[^\d-]/g, '')) || 0;
    acc[curSector].bil += bil; acc[curSector].sum += sum;
  });
  return Object.entries(acc).map(([name, t]) => ({ name, bil: t.bil, sum: t.sum }));
}

// Категория по названию сектора: танцпол/VIP — по сути всегда отдельный именованный сектор
// (распознаём по подстроке), всё остальное — «посадка» (так и просил Павел: «по сути это все
// остальные категории»). «other» оставлена про запас (сейчас всегда 0) — вдруг понадобится более
// тонкое разделение внутри «остальных» категорий.
function sectorCategory(name) {
  const n = name.toLowerCase();
  if (n.includes('танц')) return 'dance';
  if (n.includes('vip') || n.includes('вип')) return 'vip';
  return 'seat';
}

// Суммирует категории по ВСЕМ event_id одного ключа (имя|дата|время) — событие может быть
// представлено НЕСКОЛЬКИМИ отдельными записями «Событие» с одинаковым названием/датой/временем
// (см. комментарий у activeSet ниже про «Леша Свик / все хиты! 25.10.2026 19:30» — 2 записи:
// закрытая и активная), и evData()/🎫-итог по этому ключу уже суммирует продажи по ВСЕМ таким
// записям — чтобы разбивка по категориям била в ту же сумму, здесь суммируем так же.
async function categoryTotals(eventIds) {
  const cat = { dance: { bil: 0, sum: 0 }, vip: { bil: 0, sum: 0 }, seat: { bil: 0, sum: 0 }, other: { bil: 0, sum: 0 } };
  for (const id of eventIds) {
    let sectors;
    try { sectors = await sectorCategoryTotals(id); }
    catch (e) { console.error(`[debug] отчёт по секторам event_id=${id}: ${e.message || e}`); continue; }
    for (const s of sectors) {
      const c = sectorCategory(s.name);
      cat[c].bil += s.bil; cat[c].sum += s.sum;
    }
  }
  return cat;
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
      const [date, time] = dt.split(' ');
      out[`${name}|${date}|${time || ''}`] = { venue, hall };
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
// Дельта БЕЗ процента — только в штуках (Павел, 15.09: «% прироста билетов - не надо показывать»
// касается ВСЕХ строк с дельтой, включая сводную 🎫, а не только категорий 💃/🔝/🪑 — исходно тут
// был отдельный deltaStr() с процентом для 🎫, но по факту он больше нигде не нужен).
// prior === undefined — истории по этому событию ещё нет (первое появление в отчёте) →
// показываем «(новое)», а не пустоту — так «0 (новое)» и «0 (0)» всегда различимы.
function deltaUnitsStr(cur, prior) {
  if (typeof prior !== 'number') return ' (новое)';
  const d = cur - prior;
  if (d === 0) return ' (0)';
  return ` (${d > 0 ? '+' : '-'}${fmt(Math.abs(d))})`;
}

(async () => {
  await get('/');
  const cabs = await cities();
  if (!cabs.length) throw new Error('Список кабинетов пуст (кука протухла?)');

  const events = {}; // key -> {name,date,paid,free,venue,hall,cabinet}
  const eventIdsByKey = {}; // key -> [event_id,...] — для отчёта «по секторам» (разбивка по категориям)
  for (const cab of cabs) {
    await get('/city?id=' + cab.id);
    let oids;
    try { oids = await orgs(); } catch (e) { console.error(`Кабинет ${cab.name}: ${e.message}`); continue; }
    if (!oids.length) { console.error(`[debug] кабинет ${cab.id} ${cab.name}: организаторов нет`); continue; }
    const act = new Set();
    let evs = [];
    for (const oid of oids) {
      const as = await activeSet(oid);
      as.active.forEach(x => act.add(x));
      for (const [k, v] of Object.entries(as.ids)) { (eventIdsByKey[k] || (eventIdsByKey[k] = [])).push(...v); }
      evs = evs.concat(await evData(oid));
    }
    let venues = {};
    try { venues = await soldVenues(); } catch { /* нет данных о зале — не критично */ }
    let keptForCab = 0;
    for (const e of evs) {
      if (/^тест/i.test(e.name)) continue;
      if (/отмена/i.test(e.name)) continue;
      const key = `${e.name}|${e.date}|${e.time || ''}`;
      // Раньше здесь стояло `if (!act.has(key)) continue;` — оно выбрасывало ЗАКРЫТЫЕ/архивные
      // мероприятия целиком, хотя evData() (ext=1) их уже отдаёт с финальными цифрами продаж.
      // Из-за этого завершённые концерты вообще никогда не попадали в отчёт. Теперь оставляем
      // все события из evData, а через act.has(key) только помечаем «завершено/в продаже».
      const v = venues[key] || {};
      const vc = await fetchVenueCity(cab.id, v.venue);
      let city = vc.city;
      if (!city && vc.candidates.length > 1) {
        city = await disambiguateByComment(cab.id, e.name, vc.candidates);
        if (city) {
          console.error(`[info] город "${city}" для площадки "${v.venue}" (${e.name}, ${e.date} ${e.time || ''}) определён по комментарию мероприятия`);
        } else {
          ambiguousVenues.push({ venue: v.venue, cities: vc.candidates, event: e.name, date: e.date });
        }
      }
      events[key] = {
        name: e.name, date: e.date, time: e.time || '', paid: e.paid, free: e.free,
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
  //
  // Отдельный случай (найден 07.09): черновик может иметь дату уже в прошлом (его создали заранее,
  // так и не выставили на продажу, дата сама «протухла») — тогда он проходит проверку выше и
  // показывается как «Завершён, ИТОГ: 0 (новое)», хотя на самом деле в продажу не выставлялся вообще.
  // soldVenues() строит площадку («банер») ТОЛЬКО для событий, которые реально были в продаже
  // («События в продаже» в самой CMS) — значит пустой x.venue у события с нулевыми паid/free
  // означает «в продаже не был», и такое событие из отчёта тоже убираем, а не только будущие черновики.
  const keys = Object.keys(events).filter(k => {
    const x = events[k];
    const evKey = x.date.split('.').reverse().join('');
    if (!x.active && evKey >= todayKey) return false; // черновик с датой в будущем
    if (!x.active && !x.venue && x.paid === 0 && x.free === 0) return false; // черновик, который так и не был в продаже (дата уже прошла, но банера продаж никогда не было)
    return true;
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
    const d = deltaUnitsStr(x.paid, prior ? prior.paid : undefined);

    // Завершённые мероприятия показываем В СООБЩЕНИИ только ОДИН раз — в ту неделю, когда они
    // впервые стали «Завершён» (как раньше в старом скрипте). В снапшоте помечаем reported:true,
    // и на следующих неделях такое событие уже не попадает в blocks (но продолжает учитываться
    // в шапке/итогах по месяцам, пока остаётся в текущем окне FROM..TO).
    const alreadyReported = !!(prior && prior.reported);
    if (isFinished && alreadyReported) continue;

    const statusLine = `${x.name}   ${isFinished ? 'Завершён' : 'В продаже'}`;
    const cityLine = x.city ? `📍 ${x.city}\n` : '';
    // x.hall — это описание рассадки/зоны продаж («ТП + столы»), а не город/зал — в реальном
    // отчёте такого нет, поэтому в сообщение идёт только название площадки.
    const countLine = isFinished
      ? `🏁 ИТОГ: 🎫 ${fmt(x.paid)}${d}`
      : `🎫 ${fmt(x.paid)}${d}`;

    // Разбивка по категориям (💃 танцпол / 🔝 VIP / 🪑 посадка) — прототип по просьбе Павла (14.09):
    // берём event_id этого мероприятия (может быть несколько на один ключ, см. eventIdsByKey/activeSet)
    // и суммируем продажи по секторам через отчёт «По событию → По секторам». Строку категории
    // показываем, только если по ней реально что-то продано (пустые категории не нужны — напр. у
    // события «только посадка» не будет строк 💃/🔝 вовсе). Дельта — только в штуках, без процента
    // (Павел: «% прироста билетов - не надо показывать»). 🎫-итог выше эту разбивку не учитывает и
    // считается как раньше — по всем категориям сразу.
    let catLines = '';
    const priorCat = (prior && prior.cats) || {};
    try {
      const ids = eventIdsByKey[k] || [];
      if (ids.length) {
        const cat = await categoryTotals(ids);
        x.cats = cat; // сохраняем в снапшот — нужно для дельты на следующей неделе
        // Павел (15.09): сумму в рублях по категориям убрать — только кол-во + прирост в штуках,
        // как у остальных строк (без суммы, без процента).
        const parts = [];
        if (cat.dance.bil > 0) parts.push(`💃 ${fmt(cat.dance.bil)}${deltaUnitsStr(cat.dance.bil, priorCat.dance ? priorCat.dance.bil : undefined)}`);
        if (cat.vip.bil > 0) parts.push(`🔝 ${fmt(cat.vip.bil)}${deltaUnitsStr(cat.vip.bil, priorCat.vip ? priorCat.vip.bil : undefined)}`);
        if (cat.seat.bil > 0) parts.push(`🪑 ${fmt(cat.seat.bil)}${deltaUnitsStr(cat.seat.bil, priorCat.seat ? priorCat.seat.bil : undefined)}`);
        if (cat.other.bil > 0) parts.push(`Другое: ${fmt(cat.other.bil)}${deltaUnitsStr(cat.other.bil, priorCat.other ? priorCat.other.bil : undefined)}`);
        if (parts.length) catLines = '\n' + parts.join('\n');
      }
    } catch (e) {
      console.error(`[debug] разбивка по категориям "${x.name}" (${x.date} ${x.time}): ${e.message || e}`);
    }

    const freeLine = x.free ? `\n🎟️ Пригласительных: ${fmt(x.free)}` : '';
    // Дата с временем — если в этот день у мероприятия несколько разных показов (напр. «Моя Мишель»
    // 26.09 в 19:00 и 19:30 — это два разных концерта), без времени их было бы не отличить в тексте.
    const dateLine = x.time ? `${x.date} ${x.time}` : x.date;
    blocks.push(
      `${statusLine}\n${cityLine}${x.venue ? x.venue + '\n' : ''}${dateLine}\n${countLine}${catLines}${freeLine}`
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
    // cats — снимок разбивки по категориям (💃/🔝/🪑), если успели её посчитать в этот раз (см. цикл
    // выше) — нужен, чтобы на следующей неделе показать дельту по штукам для каждой категории.
    snapEvents[k] = { paid: x.paid, free: x.free, reported: isFinished, cats: x.cats };
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
  // Площадки-дубли (одинаковое название, разные города в CMS), которые не удалось различить даже
  // по комментарию мероприятия — город не показан. Список — только в лог, Павлу для ручной проверки
  // /переименования дублей в разделе «Залы» (или уточнения комментария у мероприятия).
  if (ambiguousVenues.length) {
    console.error('[warn] город не определён однозначно (в CMS несколько залов с одинаковым названием, но разными городами):');
    for (const a of ambiguousVenues) console.error(`  - "${a.venue}" (${a.event}, ${a.date}): ${a.cities.join(' / ')}`);
  }
  console.log(`OK: кабинетов ${cabs.length}, мероприятий ${keys.length} (в продаже ${onSale}, завершено ${finished})`);
})().catch(e => { console.error(e.message || e); process.exit(1); });
