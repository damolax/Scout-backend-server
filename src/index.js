const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const ADMIN_KEY = process.env.ADMIN_KEY || 'scout-admin-2026';

// ── IN-MEMORY STORES ──────────────────────────────────────────────────────────
let contactedPlaceIds = {};
let dailySummaries = [];

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DORK_SETTINGS_FILE = path.join(DATA_DIR, 'dork-settings.json');
const DORK_LEADS_FILE = path.join(DATA_DIR, 'dork-leads.json');

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function readJsonFile(file, fallback) {
  try {
    ensureDataDir();
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}

function writeJsonFile(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function normalizeDorkSettings(input = {}) {
  const signals = Array.isArray(input.signals)
    ? input.signals
    : String(input.signals || '').split('\n');
  const cleanSignals = signals.map(s => String(s || '').trim()).filter(Boolean).slice(0, 200);
  const resultsRaw = parseInt(input.resultsPerSignal || input.results_per_signal || 30, 10);
  const delayRaw = parseInt(input.delayBetweenPages || input.delay_between_pages || 8000, 10);
  return {
    industry: String(input.industry || '').trim(),
    location: String(input.location || '').trim(),
    signals: cleanSignals,
    resultsPerSignal: Math.max(1, Math.min(100, Number.isFinite(resultsRaw) ? resultsRaw : 30)),
    delayBetweenPages: Math.max(500, Math.min(60000, Number.isFinite(delayRaw) ? delayRaw : 8000)),
    engine: input.engine || 'bing',
    updatedAt: new Date().toISOString(),
  };
}

function csvEscape(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }

function todayUTC() { return new Date().toISOString().slice(0, 10); }
function isToday(d) { return d === todayUTC(); }

// ── EMAIL HELPERS ─────────────────────────────────────────────────────────────

const JUNK = [
  'sentry','wixpress','example.com','godaddy','schema.org','cloudflare',
  'your-email','email@domain','name@','user@','domain.com','noreply',
  'no-reply','donotreply','bounce','postmaster','webmaster','abuse@',
  'spam@','test@','example@','privacy@','legal@','dmca@','copyright@',
  '.png','.jpg','.jpeg','.gif','.webp','.svg','.woff',
];

function cleanEmails(set) {
  return Array.from(set)
    .map(e => e.trim().toLowerCase().replace(/[.,;:)>\]]+$/, '').replace(/^[<(\[]+/, ''))
    .filter(e => /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(e))
    .filter(e => !JUNK.some(j => e.includes(j)) && e.length < 80)
    .filter((e, i, arr) => arr.indexOf(e) === i);
}

function scoreEmail(e) {
  const l = e.split('@')[0];
  if (/^(contact|hello|hi|enquir|info|mail|bookings|admin|hola|contacto)/.test(l)) return 3;
  if (/^(sales|support|help|service|office|team|studio|ventas|soporte)/.test(l)) return 2;
  if (/\d{3,}/.test(l)) return 0;
  return 1;
}

function extractEmails(html) {
  const s = new Set();
  // mailto links — highest confidence
  (html.match(/mailto:([^"'?<>\s,;]+)/gi) || []).forEach(m => s.add(m.replace(/mailto:/i, '')));
  // plain text
  (html.match(/[a-z0-9._%+\-]{1,64}@[a-z0-9.\-]+\.[a-z]{2,}/gi) || []).forEach(e => s.add(e));
  // obfuscated: user [at] domain [dot] com
  (html.match(/([a-z0-9._%+\-]+)\s*[\[(]?\s*(?:at|@)\s*[\])]?\s*([a-z0-9.\-]+)\s*[\[(]?\s*(?:dot|\.)\s*[\])]?\s*([a-z]{2,})/gi) || [])
    .forEach(m => { const c = m.replace(/\s*[\[(]?\s*(at|@)\s*[\])]?\s*/gi,'@').replace(/\s*[\[(]?\s*(dot|\.)\s*[\])]?\s*/gi,'.').replace(/\s+/g,''); if (c.includes('@')) s.add(c.toLowerCase()); });
  // JSON-LD
  (html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || []).forEach(sc => {
    try { const walk = o => { if (!o||typeof o!=='object') return; if (o.email) s.add(String(o.email)); Object.values(o).forEach(walk); }; walk(JSON.parse(sc.replace(/<[^>]+>/g,''))); } catch {}
  });
  // data-email attributes
  (html.match(/data-email=["']([^"']+@[^"']+)["']/gi) || []).forEach(m => { const e = m.match(/["']([^"']+@[^"']+)["']/); if (e) s.add(e[1]); });
  return s;
}

function extractPhones(html) {
  const s = new Set();
  (html.match(/tel:([+\d\s\-().]{7,})/gi) || []).forEach(m => { const c = m.replace(/tel:/i,'').trim(); if (c.replace(/\D/g,'').length >= 7) s.add(c); });
  return s;
}

// ── FAST PARALLEL PAGE FETCHER ────────────────────────────────────────────────

async function fetchPage(url, timeout = 7000) {
  try {
    const r = await axios.get(url, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      maxRedirects: 5,
      validateStatus: s => s < 500,
    });
    return typeof r.data === 'string' ? r.data : '';
  } catch { return ''; }
}

// Smart page priority — contact pages first, homepage, then others
const PAGE_PRIORITY = [
  '/contact', '/contact-us', '/contactus', '/contacts', '/contact-us/',
  '', '/',  // homepage
  '/about', '/about-us', '/aboutus', '/about/',
  '/get-in-touch', '/reach-us', '/reach-out', '/connect',
  '/support', '/help', '/info', '/team',
];

async function crawlSiteForEmail(websiteUrl) {
  if (!websiteUrl) return { emails: [], phones: [], reached: 0 };

  let origin;
  try {
    const u = new URL(websiteUrl.startsWith('http') ? websiteUrl : 'https://' + websiteUrl);
    origin = u.origin;
  } catch { return { emails: [], phones: [], reached: 0 }; }

  const emails = new Set();
  const phones = new Set();
  let reached = 0;

  // PHASE 1: Fetch contact page AND homepage simultaneously
  const phase1 = ['/contact', '/contact-us', '', '/about'].map(p => origin + p);
  const phase1Results = await Promise.allSettled(phase1.map(url => fetchPage(url)));

  for (const result of phase1Results) {
    if (result.status !== 'fulfilled' || !result.value) continue;
    reached++;
    extractEmails(result.value).forEach(e => emails.add(e));
    extractPhones(result.value).forEach(p => phones.add(p));
  }

  // If we found emails in phase 1 — stop here (fast path)
  const phase1Emails = cleanEmails(emails);
  if (phase1Emails.length >= 1) {
    return {
      emails: phase1Emails.sort((a,b) => scoreEmail(b)-scoreEmail(a)).slice(0,5),
      phones: Array.from(phones).slice(0,3),
      reached,
    };
  }

  // PHASE 2: Fetch 3 more pages simultaneously
  const phase2 = ['/contactus', '/get-in-touch', '/info'].map(p => origin + p);
  const phase2Results = await Promise.allSettled(phase2.map(url => fetchPage(url)));

  for (const result of phase2Results) {
    if (result.status !== 'fulfilled' || !result.value) continue;
    reached++;
    extractEmails(result.value).forEach(e => emails.add(e));
    extractPhones(result.value).forEach(p => phones.add(p));
  }

  const allEmails = cleanEmails(emails).sort((a,b) => scoreEmail(b)-scoreEmail(a));
  return { emails: allEmails.slice(0,5), phones: Array.from(phones).slice(0,3), reached };
}

// ── PLACE DETAILS ─────────────────────────────────────────────────────────────

function extractPlaceId(url) {
  if (!url) return null;
  const m = url.match(/!19s(ChIJ[^!?&]+)/);
  if (m) return decodeURIComponent(m[1]);
  try { return new URL(url).searchParams.get('place_id') || null; } catch {}
  return null;
}

async function getPlaceDetails(placeId) {
  if (!GMAPS_KEY) return { error: 'No GOOGLE_MAPS_API_KEY', website: null, phone: null };
  try {
    const r = await axios.get(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,website,formatted_phone_number,formatted_address,rating,user_ratings_total,business_status&key=${GMAPS_KEY}`, { timeout: 8000 });
    const d = r.data?.result;
    if (!d) return { error: 'No result', website: null, phone: null };
    return { name: d.name, website: d.website||null, phone: d.formatted_phone_number||null, address: d.formatted_address||null, rating: d.rating||null, reviews: d.user_ratings_total||null, status: d.business_status||null };
  } catch(e) { return { error: e.message, website: null, phone: null }; }
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({
  status: 'ok', service: 'Scout Backend v3.3', timestamp: new Date().toISOString(),
  hasGmapsKey: !!GMAPS_KEY,
  stats: { totalContacted: Object.keys(contactedPlaceIds).length, dailySummaries: dailySummaries.length }
}));

app.get('/ping', (req, res) => res.json({ ok: true }));

// ── DORKING SIGNAL SYNC ──────────────────────────────────────────────────────

app.get('/dork-settings', (req, res) => {
  const settings = readJsonFile(DORK_SETTINGS_FILE, normalizeDorkSettings({}));
  res.json({ success: true, settings });
});

app.post('/dork-settings', (req, res) => {
  const settings = normalizeDorkSettings(req.body || {});
  writeJsonFile(DORK_SETTINGS_FILE, settings);
  res.json({ success: true, settings });
});

// Backward-friendly aliases for anything calling these names.
app.get('/signals', (req, res) => {
  const settings = readJsonFile(DORK_SETTINGS_FILE, normalizeDorkSettings({}));
  res.json({ success: true, settings, signals: settings.signals });
});

app.post('/signals', (req, res) => {
  const payload = Array.isArray(req.body?.signals) ? req.body : { ...req.body, signals: req.body?.signals || req.body };
  const settings = normalizeDorkSettings(payload || {});
  writeJsonFile(DORK_SETTINGS_FILE, settings);
  res.json({ success: true, settings, signals: settings.signals });
});

app.post('/dork-leads', (req, res) => {
  const incoming = Array.isArray(req.body?.leads) ? req.body.leads : (req.body?.lead ? [req.body.lead] : []);
  if (!incoming.length) return res.status(400).json({ error: 'lead or leads required' });
  const existing = readJsonFile(DORK_LEADS_FILE, []);
  const seen = new Set(existing.map(l => String(l.email || '') + '|' + String(l.website || '')));
  let added = 0;
  incoming.forEach(raw => {
    const lead = {
      id: raw.id || Math.random().toString(36).slice(2),
      name: raw.name || raw.business_name || '',
      email: raw.email || (Array.isArray(raw.emails) ? raw.emails[0] : ''),
      emails: Array.isArray(raw.emails) ? raw.emails : (raw.email ? [raw.email] : []),
      website: raw.website || '',
      industry: raw.industry || '',
      location: raw.location || '',
      sourceQuery: raw.sourceQuery || raw.source_query || '',
      sourceSignal: raw.sourceSignal ?? raw.source_signal ?? '',
      addedAt: raw.addedAt || new Date().toISOString(),
      source: raw.source || 'dorking',
    };
    const key = String(lead.email || '') + '|' + String(lead.website || '');
    if (key.trim() && !seen.has(key)) { existing.push(lead); seen.add(key); added++; }
  });
  writeJsonFile(DORK_LEADS_FILE, existing.slice(-10000));
  res.json({ success: true, added, total: existing.length });
});

app.get('/dork-leads', (req, res) => {
  const leads = readJsonFile(DORK_LEADS_FILE, []);
  if (req.query.format === 'csv') {
    const headers = ['name','email','emails','website','industry','location','sourceQuery','sourceSignal','addedAt'];
    const lines = [headers.map(csvEscape).join(',')];
    leads.forEach(l => lines.push(headers.map(h => csvEscape(h === 'emails' ? (l.emails || []).join('; ') : l[h])).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="dork-leads.csv"');
    return res.send('\ufeff' + lines.join('\r\n'));
  }
  res.json({ success: true, total: leads.length, leads });
});

// ── EMAIL FINDING ─────────────────────────────────────────────────────────────

app.post('/find-email', async (req, res) => {
  const { website, business_name } = req.body;
  if (!website) return res.status(400).json({ error: 'website required' });
  try {
    const r = await crawlSiteForEmail(website);
    res.json({ success: true, business_name, website, ...r });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// FAST batch — crawls up to 10 sites in parallel
app.post('/batch-find-emails', async (req, res) => {
  const { businesses } = req.body;
  if (!Array.isArray(businesses)) return res.status(400).json({ error: 'businesses array required' });

  const batch = businesses.slice(0, 20); // cap at 20 for memory
  const results = await Promise.allSettled(
    batch.map(async biz => {
      if (!biz.website) return { id: biz.id, emails: [], error: 'no website' };
      const r = await crawlSiteForEmail(biz.website);
      return { id: biz.id, business_name: biz.business_name, website: biz.website, ...r };
    })
  );

  res.json({
    success: true,
    results: results.map((r, i) => r.status === 'fulfilled' ? r.value : { id: batch[i].id, emails: [], error: r.reason?.message })
  });
});

app.post('/enrich-place', async (req, res) => {
  const { place_id, maps_url, business_name } = req.body;
  const pid = place_id || extractPlaceId(maps_url);
  if (!pid) return res.status(400).json({ error: 'place_id or maps_url required' });
  try {
    const place = await getPlaceDetails(pid);
    let emailResult = { emails: [], phones: [] };
    if (place.website) {
      emailResult = await crawlSiteForEmail(place.website);
      if (place.phone) emailResult.phones = [place.phone, ...(emailResult.phones||[])].slice(0,3);
    } else if (place.phone) { emailResult.phones = [place.phone]; }
    res.json({ success: true, place_id: pid, business_name: place.name||business_name, website: place.website||null, phone: place.phone||null, address: place.address||null, rating: place.rating||null, reviews: place.reviews||null, business_status: place.status||null, emails: emailResult.emails, phones: emailResult.phones, reached: emailResult.reached });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/batch-enrich', async (req, res) => {
  const { businesses } = req.body;
  if (!Array.isArray(businesses)) return res.status(400).json({ error: 'businesses array required' });
  const results = [];
  for (const biz of businesses.slice(0,30)) {
    const pid = biz.place_id || extractPlaceId(biz.maps_url);
    if (!pid) { results.push({ id: biz.id, error: 'no place_id', emails: [], website: null }); continue; }
    try {
      const place = await getPlaceDetails(pid);
      let er = { emails: [], phones: [] };
      if (place.website) { er = await crawlSiteForEmail(place.website); if (place.phone) er.phones = [place.phone,...(er.phones||[])].slice(0,3); }
      else if (place.phone) { er.phones = [place.phone]; }
      results.push({ id: biz.id, place_id: pid, business_name: place.name||biz.business_name, website: place.website||null, phone: place.phone||null, emails: er.emails||[], phones: er.phones||[], error: place.error||null });
    } catch(e) { results.push({ id: biz.id, error: e.message, emails: [], website: null }); }
    await new Promise(r => setTimeout(r, 200)); // small delay between places
  }
  res.json({ success: true, results });
});

app.post('/extract-place-id', (req, res) => {
  const id = extractPlaceId(req.body.maps_url);
  res.json({ place_id: id, found: !!id });
});

// ── DEDUPLICATION ─────────────────────────────────────────────────────────────

app.get('/contacted/:place_id', (req, res) => {
  const r = contactedPlaceIds[req.params.place_id];
  res.json(r ? { contacted: true, contacted_at: r.contacted_at, count: r.count } : { contacted: false });
});

app.post('/check-contacted', (req, res) => {
  const { place_ids } = req.body;
  if (!Array.isArray(place_ids)) return res.status(400).json({ error: 'place_ids array required' });
  const results = {};
  place_ids.forEach(id => {
    results[id] = contactedPlaceIds[id]
      ? { contacted: true, contacted_at: contactedPlaceIds[id].contacted_at }
      : { contacted: false };
  });
  res.json({ results, checked: place_ids.length });
});

app.post('/mark-contacted', (req, res) => {
  const { place_ids } = req.body;
  if (!Array.isArray(place_ids)||!place_ids.length) return res.status(400).json({ error: 'place_ids required' });
  const now = new Date().toISOString();
  let marked = 0;
  place_ids.forEach(id => {
    if (!id) return;
    if (contactedPlaceIds[id]) contactedPlaceIds[id].count++;
    else { contactedPlaceIds[id] = { contacted_at: now, count: 1 }; marked++; }
  });
  res.json({ success: true, marked, total: Object.keys(contactedPlaceIds).length });
});

app.get('/contacted', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  res.json({ total: Object.keys(contactedPlaceIds).length, records: contactedPlaceIds });
});

// ── DAILY SUMMARIES ───────────────────────────────────────────────────────────

app.post('/daily-summary', (req, res) => {
  const { scout_name, date, stats } = req.body;
  if (!scout_name||!date||!stats) return res.status(400).json({ error: 'scout_name, date, stats required' });
  if (!isToday(date)) return res.status(400).json({ error: `Date mismatch. You submitted "${date}" but today is "${todayUTC()}". Only today's summary accepted.`, today: todayUTC(), submitted: date });
  const idx = dailySummaries.findIndex(s => s.scout_name===scout_name && s.date===date);
  const summary = { scout_name, date, stats: { contacted:0, emails_sent:0, replies_received:0, follow_ups_sent:0, cities:[], categories:[], ...stats }, submitted_at: new Date().toISOString() };
  if (idx >= 0) dailySummaries[idx] = summary; else dailySummaries.push(summary);
  res.json({ success: true, message: 'Summary recorded for '+date, summary });
});

app.get('/daily-summaries', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const data = req.query.date ? dailySummaries.filter(s => s.date===req.query.date) : dailySummaries;
  res.json({ total: data.length, summaries: data.sort((a,b) => b.submitted_at.localeCompare(a.submitted_at)) });
});

app.get('/daily-summaries/today', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const today = todayUTC();
  const data = dailySummaries.filter(s => s.date===today);
  const totals = data.reduce((a,s) => ({ contacted: a.contacted+(s.stats.contacted||0), emails_sent: a.emails_sent+(s.stats.emails_sent||0), replies_received: a.replies_received+(s.stats.replies_received||0), follow_ups_sent: a.follow_ups_sent+(s.stats.follow_ups_sent||0) }), { contacted:0, emails_sent:0, replies_received:0, follow_ups_sent:0 });
  res.json({ date: today, scouts: data.length, totals, summaries: data });
});

// ── ADMIN STATS ───────────────────────────────────────────────────────────────

app.get('/admin/stats', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const today = todayUTC();
  const todaySummaries = dailySummaries.filter(s => s.date===today);
  const last7 = Array.from({length:7}, (_,i) => {
    const d = new Date(); d.setDate(d.getDate()-i);
    const ds = d.toISOString().slice(0,10);
    const day = dailySummaries.filter(s => s.date===ds);
    return { date: ds, scouts_active: day.length, contacted: day.reduce((a,s)=>a+(s.stats.contacted||0),0), emails_sent: day.reduce((a,s)=>a+(s.stats.emails_sent||0),0), replies: day.reduce((a,s)=>a+(s.stats.replies_received||0),0) };
  });
  res.json({
    total_contacted_all_time: Object.keys(contactedPlaceIds).length,
    today: { date: today, scouts_active: todaySummaries.length, contacted: todaySummaries.reduce((a,s)=>a+(s.stats.contacted||0),0), emails_sent: todaySummaries.reduce((a,s)=>a+(s.stats.emails_sent||0),0), replies: todaySummaries.reduce((a,s)=>a+(s.stats.replies_received||0),0) },
    last_7_days: last7,
    scout_breakdown: todaySummaries,
  });
});


// ── GMAIL OAUTH ENDPOINTS ─────────────────────────────────────────────────────

// Exchange authorization code for tokens
app.post('/gmail/exchange', async (req, res) => {
  const { code, redirect_uri, client_id } = req.body;
  if (!code || !client_id) return res.status(400).json({ error: 'code and client_id required' });

  // Note: For security, client_secret should be in env var
  // User sets it up in their own Google Cloud project
  const client_secret = process.env.GOOGLE_CLIENT_SECRET || '';
  if (!client_secret) {
    return res.status(400).json({ 
      error: 'GOOGLE_CLIENT_SECRET not set on server. Add it to your Render environment variables.',
      setup_instructions: 'Go to Render dashboard → Your service → Environment → Add GOOGLE_CLIENT_SECRET'
    });
  }

  try {
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id,
      client_secret,
      redirect_uri,
      grant_type: 'authorization_code',
    }, { headers: { 'Content-Type': 'application/json' } });

    const tokens = tokenRes.data;

    // Get the user's email
    let email = 'unknown@gmail.com';
    if (tokens.access_token) {
      try {
        const profileRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { 'Authorization': 'Bearer ' + tokens.access_token }
        });
        email = profileRes.data.email || email;
      } catch {}
    }

    res.json({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in || 3600,
      email,
    });
  } catch (err) {
    const errData = err.response?.data || {};
    res.status(400).json({ error: errData.error_description || errData.error || err.message });
  }
});

// Refresh access token
app.post('/gmail/refresh', async (req, res) => {
  const { refresh_token, client_id } = req.body;
  if (!refresh_token || !client_id) return res.status(400).json({ error: 'refresh_token and client_id required' });

  const client_secret = process.env.GOOGLE_CLIENT_SECRET || '';
  if (!client_secret) return res.status(400).json({ error: 'GOOGLE_CLIENT_SECRET not set' });

  try {
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      refresh_token,
      client_id,
      client_secret,
      grant_type: 'refresh_token',
    }, { headers: { 'Content-Type': 'application/json' } });

    res.json({
      access_token: tokenRes.data.access_token,
      expires_in: tokenRes.data.expires_in || 3600,
    });
  } catch (err) {
    const errData = err.response?.data || {};
    res.status(400).json({ error: errData.error_description || err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Scout Backend v3.3 on port ${PORT} | Admin key: ${ADMIN_KEY} | Maps key: ${GMAPS_KEY?'SET':'NOT SET'}`);
});
