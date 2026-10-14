// MyBookshelf · Cloudflare Worker: ricerca a cascata (waterfall) di metadati bibliografici.
//
//   GET /?isbn=9788804667926          → cascata completa (ISBN-10/13, anche con trattini)
//   GET /?q=titolo+libro              → ricerca per titolo su OPAC SBN (risultati grezzi)
//   aggiungi &debug=1                 → mostra cosa ha risposto ogni fonte e gli errori
//
// Variabili opzionali (Cloudflare → Worker → Settings → Variables and Secrets):
//   GOOGLE_KEY   chiave Google Books (alza la quota)
//   ISBNDB_KEY   chiave ISBNdb (fase 3, a pagamento: usata solo se mancano ancora dei campi)
//
// Fasi: 1) Google Books + Open Library (parallelo)  2) OPAC SBN + NiceBooks (solo se mancano campi)  3) ISBNdb (solo con chiave).
// Wikipedia viene sempre interrogata una volta noto il titolo: ha la priorità per genere e tipo.

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8' };
const UA = { 'User-Agent': 'MyBookshelf/2.0 (https://github.com; personal catalog)', 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.5' };
const REQUIRED = ['title', 'authors', 'publisher', 'year', 'coverUrl', 'description', 'language'];
const CACHE_SECONDS = 24 * 3600;

// ───────── ISBN: pulizia, check digit, conversione ─────────
const cleanISBN = s => String(s || '').replace(/^isbn(-1[03])?:?/i, '').replace(/[\s\-–—]/g, '').toUpperCase();
const ok10 = s => /^\d{9}[\dX]$/.test(s) && [...s].reduce((a, c, i) => a + (c === 'X' ? 10 : +c) * (10 - i), 0) % 11 === 0;
const ok13 = s => /^97[89]\d{10}$/.test(s) && (10 - ([...s.slice(0, 12)].reduce((a, c, i) => a + +c * (i % 2 ? 3 : 1), 0) % 10)) % 10 === +s[12];
const to13 = s10 => { const c = '978' + s10.slice(0, 9); return c + ((10 - ([...c].reduce((a, d, i) => a + +d * (i % 2 ? 3 : 1), 0) % 10)) % 10); };
const to10 = s13 => { if (!s13.startsWith('978')) return undefined; const c = s13.slice(3, 12); const k = (11 - ([...c].reduce((a, d, i) => a + +d * (10 - i), 0) % 11)) % 11; return c + (k === 10 ? 'X' : k); };
function normalizeISBN(raw) {
  const s = cleanISBN(raw);
  if (s.length === 10 && ok10(s)) return { isbn13: to13(s), isbn10: s };
  if (s.length === 13 && ok13(s)) return { isbn13: s, isbn10: to10(s) };
  return null;
}

// ───────── HTTP: timeout + retry con backoff esponenziale e jitter ─────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => (s == null ? '' : String(s).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());

async function http(url, { timeoutMs = 6000, retries = 2, headers = {}, json = true, dbg, name } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
      if (dbg) (dbg[name] = dbg[name] || []).push({ url: url.replace(/key=[^&]+/, 'key=***'), status: r.status });
      if (r.status === 404) return null;
      if (r.status === 429 || r.status >= 500) { const ra = Number(r.headers.get('retry-after')); const e = new Error('HTTP ' + r.status); e.retry = true; e.wait = ra ? Math.min(ra * 1000, 4000) : 0; throw e; }
      if (!r.ok) { const e = new Error('HTTP ' + r.status); e.retry = false; throw e; }
      return json ? await r.json() : await r.text();
    } catch (e) {
      last = e;
      if (e.retry === false || attempt === retries) break;                      // 4xx: inutile riprovare
      await sleep(e.wait || Math.min(3000, 400 * 2 ** attempt) + Math.random() * 250);
    }
  }
  if (dbg) (dbg[name] = dbg[name] || []).push({ error: String(last && last.message || last) });
  throw last;
}

// ───────── Utilità di normalizzazione ─────────
const year = s => { const m = String(s || '').match(/\b(1[4-9]\d\d|20\d\d)\b/); return m ? +m[1] : undefined; };
const https = u => (u ? String(u).trim().split(/\s/)[0].replace(/^http:/, 'https:') : undefined);
const LANG = { ita: 'it', eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', spa: 'es', jpn: 'ja', por: 'pt', lat: 'la' };
const lang2 = s => { const m = String(s || '').toLowerCase().match(/[a-z]{2,3}/); return m ? (LANG[m[0]] || m[0].slice(0, 2)) : undefined; };
function splitPub(txt) {            // "Milano : Mondadori, 2016" → {publisher:"Mondadori", year:2016}
  txt = clean(txt); if (!txt) return {};
  const y = year(txt);
  let pub = txt.replace(/[,\s]*[\[(]?\b(1[4-9]\d\d|20\d\d)\b[\])]?\s*$/, '');
  if (pub.includes(':')) pub = pub.split(':').slice(1).join(':');
  return { publisher: clean(pub.split(';')[0]).replace(/[,.\s]+$/, ''), year: y };
}
const cleanTitle = t => clean(String(t || '').split(' / ')[0]).replace(/\s*[:;,.]\s*$/, '');

// ───────── Fonti: ognuna restituisce lo schema unico ─────────
async function srcGoogle(c) {
  const key = c.env.GOOGLE_KEY ? `&key=${c.env.GOOGLE_KEY}` : '';
  let d = await http(`https://www.googleapis.com/books/v1/volumes?q=isbn:${c.isbn13}&maxResults=1${key}`, { dbg: c.dbg, name: 'google' });
  let v = d && d.items && d.items[0] && d.items[0].volumeInfo;
  if (!v) {                                                                        // alcuni ISBN italiani escono solo come testo libero
    d = await http(`https://www.googleapis.com/books/v1/volumes?q=${c.isbn13}&maxResults=1${key}`, { dbg: c.dbg, name: 'google' });
    v = d && d.items && d.items[0] && d.items[0].volumeInfo;
  }
  if (!v) return null;
  const im = v.imageLinks || {};
  return { source: 'Google Books', title: v.title, subtitle: v.subtitle, authors: v.authors, publisher: v.publisher, year: year(v.publishedDate), genres: v.categories,
    description: v.description && clean(v.description), coverUrl: https(im.thumbnail || im.smallThumbnail), language: v.language, pages: v.pageCount };
}
async function srcOpenLibrary(c) {
  const d = await http(`https://openlibrary.org/api/books?bibkeys=ISBN:${c.isbn13}&format=json&jscmd=data`, { dbg: c.dbg, name: 'openlibrary' });
  const b = d && d['ISBN:' + c.isbn13]; if (!b) return null;
  return { source: 'Open Library', title: b.title, subtitle: b.subtitle, authors: (b.authors || []).map(a => a.name), publisher: (b.publishers || [])[0] && b.publishers[0].name,
    year: year(b.publish_date), genres: (b.subjects || []).slice(0, 15).map(s => s.name || s), coverUrl: https(b.cover && (b.cover.large || b.cover.medium)), pages: b.number_of_pages };
}
async function srcSbn(c) {
  const t = await http(`https://opac.sbn.it/opacmobilegw/search.json?isbn=${c.isbn13}`, { dbg: c.dbg, name: 'sbn', json: false });
  let d; try { d = JSON.parse(t); } catch (e) { return null; }
  const b = ((d && (d.briefRecords || d.records)) || []).find(x => x.titolo); if (!b) return null;
  const out = { source: 'OPAC SBN', title: cleanTitle(b.titolo), authors: b.autorePrincipale ? [clean(b.autorePrincipale)] : undefined, ...splitPub(b.pubblicazione), coverUrl: https(b.copertina) };
  if (b.codiceIdentificativo) {                                                    // dettaglio: lingua, pagine, Dewey, soggetti
    try {
      const f = JSON.parse(await http(`https://opac.sbn.it/opacmobilegw/full.json?bid=${encodeURIComponent(b.codiceIdentificativo)}`, { dbg: c.dbg, name: 'sbn', json: false }));
      const pp = splitPub(f.pubblicazione || ''); if (pp.publisher) out.publisher = pp.publisher; if (pp.year) out.year = pp.year;
      out.pages = +(String(f.descrizioneFisica || '').match(/(\d+)\s*p\./) || [])[1] || undefined;
      out.language = lang2(f.lingua);
      out.dewey = clean(f.classificazioneDewey || '');
      const sg = f.soggetti || f.subjects || f.parolaChiave || [];
      out.genres = (Array.isArray(sg) ? sg : [sg]).map(x => clean(typeof x === 'string' ? x : (x && (x.descrizione || x.termine || x.nome)) || '')).filter(Boolean).slice(0, 10);
      if (c.dbg) c.dbg.sbnKeys = Object.keys(f);
    } catch (e) { /* il dettaglio è facoltativo */ }
  }
  return out;
}
async function srcNiceBooks(c) {                                                  // best effort: pagina HTML, JSON-LD / meta og
  const html = await http(`https://www.nicebooks.com/?sort=relevance&search=${c.isbn13}`, { dbg: c.dbg, name: 'nicebooks', json: false, timeoutMs: 4000, retries: 0 });
  if (!html) return null;
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      let j = JSON.parse(m[1]); j = Array.isArray(j) ? j : (j['@graph'] || [j]);
      const o = j.find(x => x && /Book/i.test([].concat(x['@type'] || []).join(',')));
      if (o && o.name) { const a = o.author; return { source: 'NiceBooks', title: clean(o.name), authors: a ? [].concat(a).map(x => clean(x.name || x)) : undefined, publisher: o.publisher && clean(o.publisher.name || o.publisher), year: year(o.datePublished), pages: +o.numberOfPages || undefined }; }
    } catch (e) {}
  }
  return null;
}
async function srcIsbndb(c) {
  if (!c.env.ISBNDB_KEY) return null;
  const d = await http(`https://api2.isbndb.com/book/${c.isbn13}`, { headers: { Authorization: c.env.ISBNDB_KEY }, dbg: c.dbg, name: 'isbndb' });
  const b = d && d.book; if (!b) return null;
  return { source: 'ISBNdb', title: b.title_long || b.title, authors: b.authors, publisher: b.publisher, year: year(b.date_published), genres: b.subjects,
    description: b.synopsis || b.overview, coverUrl: https(b.image), language: lang2(b.language), pages: b.pages };
}
// Wikipedia: arricchimento (categorie + prima frase) a partire dal titolo già trovato
const normT = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const BAD_PAGE = /film|serie televisiv|miniserie|videogioc|video game|canzone|singolo|song|gruppo|band\b|cantante|attore|attrice|calciator|persona|programma|stagione|episod|citt|comune|fiume|television|actor|footballer/i;
async function srcWikipedia(c, title, author) {
  const base = String(title || '').replace(/\b(vol(?:ume)?|n(?:umero)?|#)\.?\s*\d+.*$/i, '').replace(/[.\s]+\d+\s*$/, '').replace(/\s+[-–]\s+.*$/, '').trim();
  const nb = normT(base); if (nb.length < 2) return null;
  const sur = (() => { const a = String(author || '').split(/[;&]| e /)[0].trim(); return a.includes(',') ? a.split(',')[0] : a.split(/\s+/).slice(-1)[0] || ''; })();
  for (const lang of ['it', 'en']) {
    for (const q of (lang === 'it' ? [`${base} ${sur}`.trim(), base] : [base])) {
      const d = await http(`https://${lang}.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=0&gsrlimit=5&gsrsearch=${encodeURIComponent(q)}&prop=extracts%7Ccategories&exintro=1&explaintext=1&exsentences=3&exlimit=5&cllimit=max&clshow=!hidden`,
        { dbg: c.dbg, name: 'wikipedia', timeoutMs: 5000, retries: 1 });
      const pages = Object.values((d && d.query && d.query.pages) || {}).sort((a, b) => (a.index || 99) - (b.index || 99));
      const hit = pages.find(p => { const par = (String(p.title).match(/\(([^)]*)\)/) || [])[1] || ''; if (BAD_PAGE.test(par)) return false; const t = normT(p.title); return t === nb || t.startsWith(nb + ' ') || (nb.startsWith(t + ' ') && t.length >= 4); });
      if (hit) return { source: 'Wikipedia', wikiTitle: hit.title, wikiText: String(hit.extract || '').slice(0, 500),
        wikiCats: (hit.categories || []).map(x => String(x.title).replace(/^[^:]+:/, '')).filter(x => !/wikipedia|pagine|voci |template|disambig|portale|collegament|articles|cs1|short description/i.test(x)) };
    }
  }
  return null;
}

// ───────── Merge: per ogni campo vince il primo valore non vuoto (ordine = priorità) ─────────
const empty = v => v == null || v === '' || (Array.isArray(v) && !v.length);
function merge(base, parts) {
  const out = { ...base };
  for (const f of ['title', 'subtitle', 'authors', 'publisher', 'year', 'description', 'coverUrl', 'language', 'pages', 'dewey', 'wikiText'])
    for (const p of parts) if (empty(out[f]) && !empty(p[f])) { out[f] = p[f]; break; }
  const genres = [...new Set(parts.flatMap(p => p.genres || []).map(g => String(g).trim()).filter(Boolean))];
  if (genres.length) out.genres = genres.slice(0, 15);
  const wc = [...new Set(parts.flatMap(p => p.wikiCats || []))]; if (wc.length) out.wikiCats = wc;
  if (out.authors) out.authors = [...new Set(out.authors.map(a => (a.includes(',') ? a.split(',').reverse().join(' ') : a).replace(/\s+/g, ' ').trim()).filter(Boolean))];
  if (out.publisher) out.publisher = splitPub(out.publisher).publisher || out.publisher;
  if (out.title) out.title = out.title.replace(/\s+/g, ' ').trim();
  return out;
}

// ───────── Cascata ─────────
async function waterfall(isbn, env, dbg) {
  const c = { ...isbn, env, dbg };
  const parts = [], errors = {};
  const stage = async list => {
    const r = await Promise.allSettled(list.map(([, f]) => f()));
    r.forEach((x, i) => { if (x.status === 'fulfilled') { if (x.value) parts.push(x.value); } else errors[list[i][0]] = String(x.reason && x.reason.message || x.reason); });
  };
  const state = () => { const book = merge({ isbn13: isbn.isbn13, isbn10: isbn.isbn10 }, parts); return { book, missing: REQUIRED.filter(f => empty(book[f])) }; };

  await stage([['google', () => srcGoogle(c)], ['openlibrary', () => srcOpenLibrary(c)]]);                 // FASE 1
  let s = state();
  if (s.missing.length) { await stage([['sbn', () => srcSbn(c)], ['nicebooks', () => srcNiceBooks(c)]]); s = state(); }   // FASE 2
  // Wikipedia ha la priorità per genere e tipo: viene sempre interrogata appena si conosce il titolo
  if (s.book.title) { await stage([['wikipedia', () => srcWikipedia(c, s.book.title, (s.book.authors || [])[0])]]); s = state(); }
  if (s.missing.length && env.ISBNDB_KEY) { await stage([['isbndb', () => srcIsbndb(c)]]); s = state(); }  // FASE 3
  return { book: s.book, sources: [...new Set(parts.map(p => p.source))], missing: s.missing, complete: !s.missing.length, errors };
}

// ───────── Ricerca per titolo (solo OPAC SBN, risultati grezzi) ─────────
async function searchTitle(q, env, dbg) {
  const t = await http(`https://opac.sbn.it/opacmobilegw/search.json?any=${encodeURIComponent(q)}`, { dbg, name: 'sbn', json: false });
  let d; try { d = JSON.parse(t); } catch (e) { return []; }
  return ((d && d.briefRecords) || []).slice(0, 5).map(b => ({ source: 'OPAC SBN', title: cleanTitle(b.titolo), author: clean(b.autorePrincipale), ...splitPub(b.pubblicazione), isbn: String(b.isbn || '').replace(/\D/g, ''), coverUrl: https(b.copertina) })).filter(x => x.title);
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    const dbg = u.searchParams.get('debug') ? {} : null;
    const out = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, ...extra } });
    try {
      const rawIsbn = u.searchParams.get('isbn'), q = (u.searchParams.get('q') || '').trim();
      if (rawIsbn) {
        const isbn = normalizeISBN(rawIsbn);
        if (!isbn) return out({ error: 'ISBN non valido (cifre o check digit errati)', input: rawIsbn }, 400);
        const cache = caches.default, key = new Request('https://cache.local/isbn/' + isbn.isbn13);
        if (!dbg) { const hit = await cache.match(key); if (hit) return new Response(hit.body, { headers: { ...CORS, 'X-Cache': 'HIT' } }); }
        const res = await waterfall(isbn, env, dbg);
        if (!res.book.title) return out({ error: 'Nessuna fonte ha trovato questo ISBN', isbn13: isbn.isbn13, errors: res.errors, ...(dbg ? { debug: dbg } : {}) }, 404);
        const body = JSON.stringify(dbg ? { ...res, debug: dbg } : res);
        if (!dbg) ctx.waitUntil(cache.put(key, new Response(body, { headers: { ...CORS, 'Cache-Control': 'public, max-age=' + CACHE_SECONDS } })));
        return new Response(body, { headers: { ...CORS, 'X-Cache': 'MISS' } });
      }
      if (q) return out({ results: await searchTitle(q, env, dbg), ...(dbg ? { debug: dbg } : {}) });
      return out({ error: 'usa ?isbn= oppure ?q=' }, 400);
    } catch (e) { return out({ error: String(e && e.message || e), ...(dbg ? { debug: dbg } : {}) }, 502); }
  }
};
