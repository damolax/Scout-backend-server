const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const ADMIN_KEY = process.env.ADMIN_KEY || 'scout-admin-2026';

// ── IN-MEMORY STORES (persist across requests, reset on redeploy) ─────────────
// For production persistence, replace with a DB. For now this handles
// Render's free tier fine — data persists as long as the server is running.

let contactedPlaceIds = {}; // { place_id: { contacted_at: ISO, count: N } }
let dailySummaries = [];    // [{ scout_name, date, stats, submitted_at }]

// ── HELPERS ───────────────────────────────────────────────────────────────────

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function isToday(dateStr) {
  return dateStr === todayUTC();
}

// ── EMAIL HELPERS (unchanged from v2) ─────────────────────────────────────────

const JUNK = [
  'sentry', 'wixpress', 'example.com', '.png', '.jpg', '.jpeg', '.gif',
  '.webp', '.svg', 'godaddy', 'schema.org', 'cloudflare', 'sentry.io',
  'your-email', 'email@domain', 'name@', 'user@', 'domain.com',
  'noreply', 'no-reply', 'donotreply', 'bounce', 'mailer-daemon',
  'postmaster', 'webmaster', 'abuse@', 'spam@', 'test@', 'example@',
  'privacy@', 'legal@', 'dmca@', 'copyright@',
];

function cleanEmails(set) {
  return Array.from(set)
    .map(e => e.trim().toLowerCase()
      .replace(/[.,;:)>\]]+$/, '')
      .replace(/^[<([\]]+/, ''))
    .filter(e => /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(e))
    .filter(e => !JUNK.some(j => e.includes(j)) && e.length < 80)
    .filter((e, i, arr) => arr.indexOf(e) === i);
}

function scoreEmail(email) {
  const local = email.split('@')[0];
  if (/^(contact|hello|hi|enquir|info|mail|bookings|admin)/.test(local)) return 3;
  if (/^(sales|support|help|service|office|team|studio)/.test(local)) return 2;
  if (/\d{3,}/.test(local)) return 0;
  return 1;
}

function rankEmails(emails) {
  return emails.sort((a, b) => scoreEmail(b) - scoreEmail(a));
}

async function fetchPage(url, timeout = 9000) {
  try {
    const res = await axios.get(url, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      maxRedirects: 6,
      validateStatus: s => s < 500,
    });
    return res.data || '';
  } catch { return ''; }
}

function extractEmailsFromHtml(html) {
  const emails = new Set();
  (html.match(/mailto:([^"'?<>\s,;]+)/gi) || []).forEach(m => emails.add(m.replace(/mailto:/i, '')));
  (html.match(/[a-z0-9._%+\-]{1,64}@[a-z0-9.\-]+\.[a-z]{2,}/gi) || []).forEach(e => emails.add(e));
  (html.match(/([a-z0-9._%+\-]+)\s*[\[(]?\s*(?:at|@)\s*[\])]?\s*([a-z0-9.\-]+)\s*[\[(]?\s*(?:dot|\.)\s*[\])]?\s*([a-z]{2,})/gi) || [])
    .forEach(m => {
      const c = m.replace(/\s*[\[(]?\s*(at|@)\s*[\])]?\s*/gi, '@').replace(/\s*[\[(]?\s*(dot|\.)\s*[\])]?\s*/gi, '.').replace(/\s+/g, '');
      if (c.includes('@') && c.includes('.')) emails.add(c.toLowerCase());
    });
  const scripts = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  scripts.forEach(s => {
    try {
      const json = JSON.parse(s.replace(/<script[^>]*>|<\/script>/gi, ''));
      const traverse = (obj) => { if (!obj || typeof obj !== 'object') return; if (obj.email) emails.add(String(obj.email)); Object.values(obj).forEach(traverse); };
      traverse(json);
    } catch {}
  });
  (html.match(/data-email=["']([^"']+@[^"']+)["']/gi) || []).forEach(m => { const e = m.match(/["']([^"']+@[^"']+)["']/); if (e) emails.add(e[1]); });
  return emails;
}

function extractPhonesFromHtml(html) {
  const phones = new Set();
  (html.match(/tel:([+\d\s\-().]+)/gi) || []).forEach(m => { const c = m.replace(/tel:/i, '').trim(); if (c.replace(/\D/g, '').length >= 7) phones.add(c); });
  return phones;
}

async function crawlSiteForEmail(websiteUrl) {
  if (!websiteUrl) return { emails: [], phones: [], reached: 0 };
  let origin;
  try {
    const u = new URL(websiteUrl.startsWith('http') ? websiteUrl : 'https://' + websiteUrl);
    origin = u.origin;
  } catch { return { emails: [], phones: [], reached: 0 }; }

  const paths = ['', '/contact', '/contact-us', '/contactus', '/contacts', '/about', '/about-us', '/get-in-touch', '/support', '/help', '/info', '/team'];
  const emails = new Set();
  const phones = new Set();
  let reached = 0;

  for (const p of paths) {
    const html = await fetchPage(origin + p);
    if (!html) continue;
    reached++;
    extractEmailsFromHtml(html).forEach(e => emails.add(e));
    extractPhonesFromHtml(html).forEach(p => phones.add(p));
    const cleaned = cleanEmails(emails);
    if (cleaned.length >= 3 && p.includes('contact')) break;
    if (cleaned.length >= 4) break;
  }

  return {
    emails: rankEmails(cleanEmails(emails)).slice(0, 5),
    phones: Array.from(phones).slice(0, 3),
    reached,
  };
}

function extractPlaceIdFromUrl(mapsUrl) {
  if (!mapsUrl) return null;
  const m = mapsUrl.match(/!19s(ChIJ[^!?&]+)/);
  if (m) return decodeURIComponent(m[1]);
  try { return new URL(mapsUrl).searchParams.get('place_id') || null; } catch {}
  return null;
}

async function getPlaceDetails(placeId) {
  if (!GMAPS_KEY) return { error: 'No GOOGLE_MAPS_API_KEY', website: null, phone: null };
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,website,formatted_phone_number,formatted_address,rating,user_ratings_total,business_status&key=${GMAPS_KEY}`;
    const res = await axios.get(url, { timeout: 8000 });
    const r = res.data?.result;
    if (!r) return { error: 'No result', website: null, phone: null };
    return { name: r.name, website: r.website || null, phone: r.formatted_phone_number || null, address: r.formatted_address || null, rating: r.rating || null, reviews: r.user_ratings_total || null, status: r.business_status || null };
  } catch (err) { return { error: err.message, website: null, phone: null }; }
}

// ── ROUTES: HEALTH ────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Scout Backend v3',
    timestamp: new Date().toISOString(),
    hasGmapsKey: !!GMAPS_KEY,
    stats: {
      totalContacted: Object.keys(contactedPlaceIds).length,
      dailySummaries: dailySummaries.length,
    }
  });
});

// ── ROUTES: EMAIL FINDING ─────────────────────────────────────────────────────

app.post('/find-email', async (req, res) => {
  const { website, business_name } = req.body;
  if (!website) return res.status(400).json({ error: 'website required' });
  try {
    const result = await crawlSiteForEmail(website);
    res.json({ success: true, business_name, website, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/batch-find-emails', async (req, res) => {
  const { businesses } = req.body;
  if (!Array.isArray(businesses)) return res.status(400).json({ error: 'businesses array required' });
  const results = [];
  for (const biz of businesses.slice(0, 50)) {
    if (!biz.website) { results.push({ id: biz.id, emails: [], error: 'no website' }); continue; }
    const result = await crawlSiteForEmail(biz.website);
    results.push({ id: biz.id, business_name: biz.business_name, website: biz.website, ...result });
    await new Promise(r => setTimeout(r, 400));
  }
  res.json({ success: true, results });
});

app.post('/enrich-place', async (req, res) => {
  const { place_id, maps_url, business_name } = req.body;
  const pid = place_id || extractPlaceIdFromUrl(maps_url);
  if (!pid) return res.status(400).json({ error: 'place_id or maps_url required' });
  try {
    const place = await getPlaceDetails(pid);
    let emailResult = { emails: [], phones: [] };
    if (place.website) {
      emailResult = await crawlSiteForEmail(place.website);
      if (place.phone && !emailResult.phones.includes(place.phone)) emailResult.phones = [place.phone, ...(emailResult.phones || [])].slice(0, 3);
    } else if (place.phone) { emailResult.phones = [place.phone]; }
    res.json({ success: true, place_id: pid, business_name: place.name || business_name, website: place.website || null, phone: place.phone || null, address: place.address || null, rating: place.rating || null, reviews: place.reviews || null, business_status: place.status || null, emails: emailResult.emails, phones: emailResult.phones, reached: emailResult.reached });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/batch-enrich', async (req, res) => {
  const { businesses } = req.body;
  if (!Array.isArray(businesses)) return res.status(400).json({ error: 'businesses array required' });
  const results = [];
  for (const biz of businesses.slice(0, 30)) {
    const pid = biz.place_id || extractPlaceIdFromUrl(biz.maps_url);
    if (!pid) { results.push({ id: biz.id, error: 'no place_id', emails: [], website: null }); continue; }
    try {
      const place = await getPlaceDetails(pid);
      let emailResult = { emails: [], phones: [] };
      if (place.website) {
        emailResult = await crawlSiteForEmail(place.website);
        if (place.phone) emailResult.phones = [place.phone, ...(emailResult.phones || [])].slice(0, 3);
      } else if (place.phone) { emailResult.phones = [place.phone]; }
      results.push({ id: biz.id, place_id: pid, business_name: place.name || biz.business_name, website: place.website || null, phone: place.phone || null, address: place.address || null, emails: emailResult.emails || [], phones: emailResult.phones || [], error: place.error || null });
    } catch (err) { results.push({ id: biz.id, error: err.message, emails: [], website: null }); }
    await new Promise(r => setTimeout(r, 500));
  }
  res.json({ success: true, results });
});

app.post('/extract-place-id', (req, res) => {
  res.json({ place_id: extractPlaceIdFromUrl(req.body.maps_url), found: !!extractPlaceIdFromUrl(req.body.maps_url) });
});

// ── ROUTES: DEDUPLICATION ─────────────────────────────────────────────────────

// Check if a single place_id has been contacted
app.get('/contacted/:place_id', (req, res) => {
  const record = contactedPlaceIds[req.params.place_id];
  if (record) {
    res.json({ contacted: true, contacted_at: record.contacted_at, count: record.count });
  } else {
    res.json({ contacted: false });
  }
});

// Check multiple place_ids at once (for CSV upload dedup)
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

// Mark one or more businesses as contacted (called when email is sent)
app.post('/mark-contacted', (req, res) => {
  const { place_ids } = req.body; // array of place_ids
  if (!Array.isArray(place_ids) || !place_ids.length) return res.status(400).json({ error: 'place_ids array required' });
  const now = new Date().toISOString();
  let marked = 0;
  place_ids.forEach(id => {
    if (!id) return;
    if (contactedPlaceIds[id]) {
      contactedPlaceIds[id].count++;
    } else {
      contactedPlaceIds[id] = { contacted_at: now, count: 1 };
      marked++;
    }
  });
  res.json({ success: true, marked, total_contacted: Object.keys(contactedPlaceIds).length });
});

// Get full contacted list (admin only)
app.get('/contacted', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  res.json({
    total: Object.keys(contactedPlaceIds).length,
    records: contactedPlaceIds,
  });
});

// ── ROUTES: DAILY SUMMARIES ───────────────────────────────────────────────────

// Submit daily summary — date must be today
app.post('/daily-summary', (req, res) => {
  const { scout_name, date, stats } = req.body;

  if (!scout_name || !date || !stats) {
    return res.status(400).json({ error: 'scout_name, date, and stats required' });
  }

  // Strict date validation — must be today's date
  if (!isToday(date)) {
    return res.status(400).json({
      error: `Date mismatch. You submitted "${date}" but today is "${todayUTC()}". Only today's summary can be uploaded.`,
      today: todayUTC(),
      submitted: date,
    });
  }

  // Check if this scout already submitted today — update instead of duplicate
  const existingIdx = dailySummaries.findIndex(s => s.scout_name === scout_name && s.date === date);
  const summary = {
    scout_name,
    date,
    stats: {
      contacted: stats.contacted || 0,
      emails_sent: stats.emails_sent || 0,
      replies_received: stats.replies_received || 0,
      follow_ups_sent: stats.follow_ups_sent || 0,
      cities: stats.cities || [],
      categories: stats.categories || [],
      ...stats,
    },
    submitted_at: new Date().toISOString(),
  };

  if (existingIdx >= 0) {
    dailySummaries[existingIdx] = summary;
  } else {
    dailySummaries.push(summary);
  }

  res.json({ success: true, message: 'Summary recorded for ' + date, summary });
});

// Get all daily summaries (admin)
app.get('/daily-summaries', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const date = req.query.date; // optional filter
  const data = date ? dailySummaries.filter(s => s.date === date) : dailySummaries;
  res.json({
    total: data.length,
    summaries: data.sort((a, b) => b.submitted_at.localeCompare(a.submitted_at)),
  });
});

// Get today's summaries (admin)
app.get('/daily-summaries/today', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const today = todayUTC();
  const data = dailySummaries.filter(s => s.date === today);
  const totals = data.reduce((acc, s) => {
    acc.contacted += s.stats.contacted || 0;
    acc.emails_sent += s.stats.emails_sent || 0;
    acc.replies_received += s.stats.replies_received || 0;
    acc.follow_ups_sent += s.stats.follow_ups_sent || 0;
    return acc;
  }, { contacted: 0, emails_sent: 0, replies_received: 0, follow_ups_sent: 0 });
  res.json({ date: today, scouts: data.length, totals, summaries: data });
});

// ── ROUTES: ADMIN DASHBOARD DATA ─────────────────────────────────────────────

app.get('/admin/stats', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
  const today = todayUTC();
  const todaySummaries = dailySummaries.filter(s => s.date === today);
  const last7Days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const daySummaries = dailySummaries.filter(s => s.date === dateStr);
    last7Days.push({
      date: dateStr,
      scouts_active: daySummaries.length,
      contacted: daySummaries.reduce((a, s) => a + (s.stats.contacted || 0), 0),
      emails_sent: daySummaries.reduce((a, s) => a + (s.stats.emails_sent || 0), 0),
      replies: daySummaries.reduce((a, s) => a + (s.stats.replies_received || 0), 0),
    });
  }
  res.json({
    total_contacted_all_time: Object.keys(contactedPlaceIds).length,
    today: {
      date: today,
      scouts_active: todaySummaries.length,
      contacted: todaySummaries.reduce((a, s) => a + (s.stats.contacted || 0), 0),
      emails_sent: todaySummaries.reduce((a, s) => a + (s.stats.emails_sent || 0), 0),
      replies: todaySummaries.reduce((a, s) => a + (s.stats.replies_received || 0), 0),
    },
    last_7_days: last7Days,
    scout_breakdown: todaySummaries,
  });
});

// Keep-alive for Render free tier
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`Scout Backend v3 running on port ${PORT}`);
  console.log(`Admin key: ${ADMIN_KEY}`);
  console.log(`Google Maps API key: ${GMAPS_KEY ? 'SET ✓' : 'NOT SET'}`);
});
