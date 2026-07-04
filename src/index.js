const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const ADMIN_KEY = process.env.ADMIN_KEY || 'scout-admin-2026';
const EMAIL_VERIFIER_PROVIDER = String(process.env.EMAIL_VERIFIER_PROVIDER || '').toLowerCase();
const ZEROBOUNCE_API_KEY = process.env.ZEROBOUNCE_API_KEY || '';
const ABSTRACT_EMAIL_API_KEY = process.env.ABSTRACT_EMAIL_API_KEY || '';
const HUNTER_API_KEY = process.env.HUNTER_API_KEY || '';
const NEVERBOUNCE_API_KEY = process.env.NEVERBOUNCE_API_KEY || '';
const KICKBOX_API_KEY = process.env.KICKBOX_API_KEY || '';
const SEARCH_PROVIDER = String(process.env.SEARCH_PROVIDER || 'auto').toLowerCase();
const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY || '';
const GOOGLE_CSE_API_KEY = process.env.GOOGLE_CSE_API_KEY || process.env.GOOGLE_CUSTOM_SEARCH_API_KEY || '';
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX || process.env.GOOGLE_CUSTOM_SEARCH_CX || '';

// ── IN-MEMORY STORES ──────────────────────────────────────────────────────────
let contactedPlaceIds = {};
let dailySummaries = [];

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DORK_SETTINGS_FILE = path.join(DATA_DIR, 'dork-settings.json');
const DORK_LEADS_FILE = path.join(DATA_DIR, 'dork-leads.json');
const CAMPAIGNS_FILE = path.join(DATA_DIR, 'dork-campaigns.json');
const MAP_CAMPAIGNS_FILE = path.join(DATA_DIR, 'maps-campaigns.json');
const MESSAGE_TEMPLATES_FILE = path.join(DATA_DIR, 'message-templates.json');

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


async function fetchPageDetailed(url, timeout = 15000) {
  try {
    const r = await axios.get(url, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      maxRedirects: 5,
      validateStatus: s => s < 500,
    });
    const text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data || '');
    return { ok: r.status < 400, status: r.status, url, text, length: text.length, error: '' };
  } catch (e) {
    return { ok: false, status: e.response?.status || 0, url, text: '', length: 0, error: e.message || String(e) };
  }
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


// ── EMAIL VERIFICATION HELPERS ───────────────────────────────────────────────

const ROLE_PREFIXES = new Set([
  'info','contact','hello','hi','sales','support','help','admin','office','team','mail','enquiries','enquiry',
  'booking','bookings','appointments','service','services','customerservice','customer.service','reception',
  'marketing','business','operations','care','clientcare','frontdesk','studio','quotes','quote','accounts'
]);
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com','yahoo.com','outlook.com','hotmail.com','live.com','icloud.com','aol.com','proton.me','protonmail.com',
  'mail.com','zoho.com','yandex.com','gmx.com','msn.com'
]);
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com','10minutemail.com','guerrillamail.com','tempmail.com','temp-mail.org','throwawaymail.com',
  'yopmail.com','trashmail.com','getnada.com','sharklasers.com','dispostable.com','fakeinbox.com'
]);

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase().replace(/^mailto:/, '').split('?')[0].replace(/[.,;:)>"]+$/, '').replace(/^[<(\[]+/, '');
}

function isLikelyEmail(email) {
  const e = normalizeEmail(email);
  if (!e || e.length > 254) return false;
  const parts = emailParts(e);
  if (!parts.validFormat) return false;
  if (!parts.local || !parts.domain) return false;
  if (parts.local.length > 64) return false;
  if (parts.local.startsWith('.') || parts.local.endsWith('.') || parts.local.includes('..')) return false;
  if (parts.domain.includes('..')) return false;
  const labels = parts.domain.split('.');
  if (labels.some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return false;
  if (DISPOSABLE_DOMAINS.has(parts.domain)) return false;
  if (JUNK.some(j => e.includes(j))) return false;
  return true;
}

function emailParts(email) {
  const normalized = normalizeEmail(email);
  const m = normalized.match(/^([a-z0-9._%+\-]{1,64})@([a-z0-9.\-]+\.[a-z]{2,})$/i);
  if (!m) return { normalized, local: '', domain: '', validFormat: false };
  return { normalized, local: m[1], domain: m[2], validFormat: true };
}
function isRoleEmail(local) {
  const base = String(local || '').toLowerCase().split(/[+._-]/)[0];
  return ROLE_PREFIXES.has(base) || /^(info|contact|hello|sales|support|admin|office|team|booking|enquir)/.test(base);
}
function getVerifierProviderKey(provider) {
  provider = String(provider || EMAIL_VERIFIER_PROVIDER || '').toLowerCase();
  if (provider === 'zerobounce') return ZEROBOUNCE_API_KEY;
  if (provider === 'abstract') return ABSTRACT_EMAIL_API_KEY;
  if (provider === 'hunter') return HUNTER_API_KEY;
  if (provider === 'neverbounce') return NEVERBOUNCE_API_KEY;
  if (provider === 'kickbox') return KICKBOX_API_KEY;
  return '';
}

async function checkMx(domain) {
  try {
    const records = await dns.resolveMx(domain);
    const sorted = (records || []).sort((a,b) => (a.priority || 0) - (b.priority || 0));
    return { hasMx: sorted.length > 0, mxRecords: sorted.map(r => r.exchange).slice(0, 5) };
  } catch(e) {
    // Some domains accept mail on A record even without MX, but for outreach treat no-MX as not ready.
    return { hasMx: false, mxRecords: [], mxError: e.code || e.message };
  }
}

function providerToStatus(provider, data) {
  provider = String(provider || '').toLowerCase();
  let raw = '', reason = '', score = null;

  if (provider === 'zerobounce') {
    raw = String(data.status || '').toLowerCase();
    reason = data.sub_status || data.did_you_mean || raw;
  } else if (provider === 'abstract') {
    raw = String(data.deliverability || '').toLowerCase();
    reason = data.quality_score != null ? `quality_score=${data.quality_score}` : raw;
    score = data.quality_score != null ? Math.round(Number(data.quality_score) * 100) : null;
  } else if (provider === 'hunter') {
    raw = String(data.data?.status || data.status || data.data?.result || '').toLowerCase();
    reason = data.data?.result || data.data?.regexp || raw;
    score = data.data?.score != null ? Number(data.data.score) : null;
  } else if (provider === 'neverbounce') {
    raw = String(data.result || '').toLowerCase();
    reason = data.flags ? String(data.flags) : raw;
  } else if (provider === 'kickbox') {
    raw = String(data.result || '').toLowerCase();
    reason = data.reason || raw;
  }

  if (/^(valid|deliverable)$/.test(raw)) return { status: 'valid', providerStatus: raw, providerReason: reason, providerScore: score };
  if (/catch|accept_all|accept-all/.test(raw)) return { status: 'catch_all', providerStatus: raw, providerReason: reason, providerScore: score };
  if (/risk|risky|role|webmail/.test(raw)) return { status: 'risky', providerStatus: raw, providerReason: reason, providerScore: score };
  if (/invalid|undeliverable|do_not_mail|spamtrap|abuse|disposable/.test(raw)) return { status: 'invalid', providerStatus: raw, providerReason: reason, providerScore: score };
  return { status: 'unknown', providerStatus: raw || 'unknown', providerReason: reason || 'unknown', providerScore: score };
}

async function verifyWithProvider(email, provider) {
  provider = String(provider || EMAIL_VERIFIER_PROVIDER || '').toLowerCase();
  const key = getVerifierProviderKey(provider);
  if (!provider || !key) return null;
  const encodedEmail = encodeURIComponent(email);
  let url = '';
  if (provider === 'zerobounce') url = `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(key)}&email=${encodedEmail}`;
  else if (provider === 'abstract') url = `https://emailvalidation.abstractapi.com/v1/?api_key=${encodeURIComponent(key)}&email=${encodedEmail}`;
  else if (provider === 'hunter') url = `https://api.hunter.io/v2/email-verifier?email=${encodedEmail}&api_key=${encodeURIComponent(key)}`;
  else if (provider === 'neverbounce') url = `https://api.neverbounce.com/v4/single/check?key=${encodeURIComponent(key)}&email=${encodedEmail}`;
  else if (provider === 'kickbox') url = `https://api.kickbox.com/v2/verify?email=${encodedEmail}&apikey=${encodeURIComponent(key)}`;
  else return null;

  try {
    const res = await axios.get(url, { timeout: 15000, validateStatus: s => s < 500 });
    return { provider, raw: res.data, ...providerToStatus(provider, res.data || {}) };
  } catch(e) {
    return { provider, status: 'unknown', providerStatus: 'error', providerReason: e.message, raw: null };
  }
}

async function verifyEmailAddress(email, provider = EMAIL_VERIFIER_PROVIDER) {
  const parts = emailParts(email);
  const base = {
    email: parts.normalized,
    domain: parts.domain,
    validFormat: parts.validFormat,
    isRoleBased: parts.validFormat ? isRoleEmail(parts.local) : false,
    isFreeProvider: parts.validFormat ? FREE_EMAIL_DOMAINS.has(parts.domain) : false,
    isDisposable: parts.validFormat ? DISPOSABLE_DOMAINS.has(parts.domain) : false,
    hasMx: false,
    mxRecords: [],
    provider: provider || 'basic_mx',
    providerStatus: '',
    providerReason: '',
    status: 'unknown',
    score: 0,
    readyToContact: false,
    checkedAt: new Date().toISOString(),
  };

  if (!parts.validFormat) return { ...base, status: 'invalid', providerReason: 'bad_format', score: 0 };
  if (base.isDisposable) return { ...base, status: 'invalid', providerReason: 'disposable_domain', score: 0 };

  const mx = await checkMx(parts.domain);
  base.hasMx = mx.hasMx; base.mxRecords = mx.mxRecords; if (mx.mxError) base.mxError = mx.mxError;
  if (!base.hasMx) return { ...base, status: 'invalid', providerReason: 'no_mx_records', score: 5 };

  const providerResult = await verifyWithProvider(parts.normalized, provider);
  if (providerResult) {
    let score = 50;
    if (providerResult.status === 'valid') score = 90;
    else if (providerResult.status === 'catch_all') score = 62;
    else if (providerResult.status === 'risky') score = 55;
    else if (providerResult.status === 'unknown') score = 45;
    else if (providerResult.status === 'invalid') score = 0;
    if (base.isRoleBased && score > 0) score -= 10;
    if (base.isFreeProvider && score > 0) score -= 5;
    score = Math.max(0, Math.min(100, providerResult.providerScore != null ? Number(providerResult.providerScore) : score));
    return {
      ...base,
      provider: providerResult.provider,
      providerStatus: providerResult.providerStatus,
      providerReason: providerResult.providerReason,
      providerRaw: providerResult.raw,
      status: providerResult.status,
      score,
      readyToContact: providerResult.status === 'valid' && score >= 70,
    };
  }

  // Built-in free mode: safe but conservative. It proves the domain can receive mail, not that this mailbox exists.
  let score = 58;
  if (base.isRoleBased) score -= 8;
  if (base.isFreeProvider) score -= 5;
  return {
    ...base,
    provider: 'basic_mx',
    providerStatus: 'mx_found_only',
    providerReason: 'No external verifier API key configured. MX/domain check passed but mailbox-level verification was not performed.',
    status: base.isRoleBased ? 'risky' : 'needs_provider',
    score,
    readyToContact: false,
  };
}

function applyVerificationToLead(lead, result) {
  return {
    ...lead,
    verificationStatus: result.status,
    verificationScore: result.score,
    verificationProvider: result.provider,
    verificationReason: result.providerReason,
    verifierStatus: result.providerStatus,
    verifiedAt: result.checkedAt,
    isRoleBased: result.isRoleBased,
    isFreeProvider: result.isFreeProvider,
    isDisposable: result.isDisposable,
    hasMx: result.hasMx,
    readyToContact: !!result.readyToContact,
  };
}

function leadMatchesStatus(lead, status) {
  if (!status) return true;
  if (status === 'ready') return !!lead.readyToContact;
  if (status === 'needs_verification') return !lead.verificationStatus || lead.verificationStatus === 'needs_verification';
  return lead.verificationStatus === status;
}


// ── CLOUD DORK CAMPAIGN RUNNER ──────────────────────────────────────────────

const runningCampaigns = new Map();

function normalizeUrl(v) {
  const raw = String(v || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw.startsWith('http') ? raw : 'https://' + raw);
    u.hash = '';
    return u.toString();
  } catch { return raw; }
}

function rootDomain(url) {
  try { return new URL(url.startsWith('http') ? url : 'https://' + url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

function normalizeNameKey(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 90);
}

function allLeadDedupeKeys(lead) {
  const keys = [];
  const email = normalizeEmail(lead.email || (Array.isArray(lead.emails) ? lead.emails[0] : ''));
  if (email) keys.push('email:' + email);

  // Google Maps browser mode often discovers the business card/profile before a website/email exists.
  // The previous version could skip those rows because it only deduped by email/place/site/name+location.
  // Keep a Maps/profile URL key so browser Maps leads can be stored first, then enriched/merged later.
  const placeId = String(lead.placeId || lead.place_id || lead.googlePlaceId || lead.google_place_id || '').trim();
  if (placeId) keys.push('place:' + placeId);

  const mapsUrl = normalizeUrl(lead.mapsUrl || lead.maps_url || lead.googleMapsUrl || lead.google_maps_url || '');
  if (mapsUrl) keys.push('mapsurl:' + mapsUrl.replace(/\/$/, '').toLowerCase());

  const website = rootDomain(lead.website || lead.url || '');
  if (website && !/(^|\.)google\./i.test(website)) keys.push('site:' + website);

  const nameKey = normalizeNameKey(lead.businessName || lead.name || lead.companyName || '');
  const locKey = normalizeNameKey(lead.location || lead.city || lead.address || '');
  if (nameKey && locKey) keys.push('name_loc:' + nameKey + '|' + locKey);

  // Last-resort browser Maps key. This is not used for normal dork/uploaded leads.
  // It prevents "0 imported" when Maps has business names but no website/email yet.
  const src = String(lead.source || '').toLowerCase();
  if (!keys.length && nameKey && src.includes('google_maps')) keys.push('mapsname:' + nameKey);

  return Array.from(new Set(keys));
}

function leadDedupeKey(lead) {
  return allLeadDedupeKeys(lead)[0] || '';
}

function uniquePush(arr, values) {
  const out = Array.isArray(arr) ? arr.slice() : [];
  const seen = new Set(out.map(v => String(v || '').toLowerCase()));
  (Array.isArray(values) ? values : [values]).forEach(v => {
    const clean = String(v || '').trim();
    const key = clean.toLowerCase();
    if (clean && !seen.has(key)) { out.push(clean); seen.add(key); }
  });
  return out;
}

function normalizeDorkLead(raw = {}, context = {}) {
  const email = normalizeEmail(raw.email || (Array.isArray(raw.emails) ? raw.emails[0] : ''));
  const emails = uniquePush([], [email, ...(Array.isArray(raw.emails) ? raw.emails : [])].map(normalizeEmail).filter(Boolean));
  const website = normalizeUrl(raw.website || raw.url || raw.sourceUrl || raw.source_url || '');
  const domain = rootDomain(website);
  const name = String(raw.name || raw.businessName || raw.business_name || raw.title || domain || (email ? email.split('@')[0] : 'Web lead')).trim();
  const now = new Date().toISOString();
  return {
    id: raw.id || 'lead_' + Math.random().toString(36).slice(2) + Date.now().toString(36),
    name,
    businessName: raw.businessName || raw.business_name || raw.name || name,
    companyName: raw.companyName || raw.company_name || raw.businessName || raw.business_name || name,
    email,
    emails,
    website,
    domain,
    placeId: raw.placeId || raw.place_id || raw.googlePlaceId || raw.google_place_id || '',
    address: raw.address || raw.formattedAddress || raw.formatted_address || '',
    city: raw.city || '',
    state: raw.state || '',
    country: raw.country || '',
    phone: raw.phone || raw.phoneNumber || raw.phone_number || '',
    rating: raw.rating ?? '',
    reviews: raw.reviews ?? raw.reviewCount ?? raw.userRatingCount ?? raw.user_ratings_total ?? '',
    category: raw.category || raw.industry || context.industry || '',
    categories: uniquePush([], raw.categories || raw.types || []),
    mapsUrl: raw.mapsUrl || raw.maps_url || raw.googleMapsUrl || raw.google_maps_url || '',
    domainSource: raw.domainSource || '',
    industry: raw.industry || context.industry || '',
    location: raw.location || context.location || '',
    sourceQuery: raw.sourceQuery || raw.source_query || context.sourceQuery || '',
    sourceSignal: raw.sourceSignal ?? raw.source_signal ?? context.sourceSignal ?? '',
    sourceUrl: raw.sourceUrl || raw.source_url || website || '',
    source: raw.source || context.source || 'cloud_campaign',
    sourceEngine: raw.sourceEngine || context.sourceEngine || 'bing',
    campaignId: raw.campaignId || context.campaignId || '',
    campaignIds: uniquePush(raw.campaignIds || [], [raw.campaignId || context.campaignId].filter(Boolean)),
    sources: uniquePush(raw.sources || [], [raw.sourceUrl || raw.source_url || website, raw.sourceQuery || raw.source_query || context.sourceQuery].filter(Boolean)),
    sourceSignals: uniquePush(raw.sourceSignals || [], [raw.sourceSignal ?? raw.source_signal ?? context.sourceSignal].filter(v => String(v ?? '').trim() !== '')),
    sourceQueries: uniquePush(raw.sourceQueries || [], [raw.sourceQuery || raw.source_query || context.sourceQuery].filter(Boolean)),
    addedAt: raw.addedAt || raw.createdAt || now,
    firstSeenAt: raw.firstSeenAt || raw.addedAt || now,
    lastSeenAt: raw.lastSeenAt || now,
    importedAt: raw.importedAt || '',
    lastEnrichedAt: raw.lastEnrichedAt || '',
    sourceCount: Number(raw.sourceCount || 1),
    status: raw.status || 'found',
    verificationStatus: raw.verificationStatus || raw.verification_status || 'needs_verification',
    verificationScore: raw.verificationScore || raw.verification_score || '',
    verificationProvider: raw.verificationProvider || raw.verification_provider || '',
    verificationReason: raw.verificationReason || raw.verification_reason || '',
    verifiedAt: raw.verifiedAt || raw.verified_at || '',
    leadScore: raw.leadScore || raw.lead_score || 0,
    messageStatus: raw.messageStatus || raw.message_status || '',
    messageTemplateId: raw.messageTemplateId || raw.message_template_id || '',
    messageSubject: raw.messageSubject || raw.message_subject || '',
    messageBody: raw.messageBody || raw.message_body || '',
    messageMissingCodes: raw.messageMissingCodes || raw.message_missing_codes || [],
    readyToContact: !!(raw.readyToContact || raw.ready_to_contact),
  };
}

function mergeDorkLead(existing, incoming) {
  const now = new Date().toISOString();
  const merged = { ...existing };
  ['name','businessName','companyName','website','domain','placeId','address','city','state','country','phone','rating','reviews','category','mapsUrl','industry','location','sourceQuery','sourceSignal','sourceUrl','sourceEngine','campaignId'].forEach(k => {
    if (!merged[k] && incoming[k]) merged[k] = incoming[k];
  });
  merged.email = existing.email || incoming.email;
  merged.emails = uniquePush(existing.emails || [], incoming.emails || incoming.email);
  merged.categories = uniquePush(existing.categories || [], incoming.categories || incoming.category);
  merged.campaignIds = uniquePush(existing.campaignIds || [], incoming.campaignIds || incoming.campaignId);
  merged.sources = uniquePush(existing.sources || [], incoming.sources || incoming.sourceUrl || incoming.website || incoming.sourceQuery);
  merged.sourceSignals = uniquePush(existing.sourceSignals || [], incoming.sourceSignals || incoming.sourceSignal);
  merged.sourceQueries = uniquePush(existing.sourceQueries || [], incoming.sourceQueries || incoming.sourceQuery);
  merged.firstSeenAt = existing.firstSeenAt || existing.addedAt || incoming.firstSeenAt || incoming.addedAt || now;
  merged.lastSeenAt = now;
  merged.updatedAt = now;
  merged.sourceCount = Math.max(Number(existing.sourceCount || 1), (merged.sources || []).length || 1);
  // Never downgrade verification fields if the email was already verified.
  if (!existing.verificationStatus || existing.verificationStatus === 'needs_verification') {
    merged.verificationStatus = incoming.verificationStatus || existing.verificationStatus || 'needs_verification';
    merged.verificationScore = incoming.verificationScore || existing.verificationScore || '';
    merged.verificationProvider = incoming.verificationProvider || existing.verificationProvider || '';
    merged.verificationReason = incoming.verificationReason || existing.verificationReason || '';
    merged.verifiedAt = incoming.verifiedAt || existing.verifiedAt || '';
    merged.readyToContact = !!(incoming.readyToContact || existing.readyToContact);
  }
  return merged;
}

function saveDorkLeadBatch(incoming = [], context = {}) {
  const leads = readJsonFile(DORK_LEADS_FILE, []);
  const byKey = new Map();
  leads.forEach((lead, idx) => {
    const normalized = normalizeDorkLead(lead, {});
    leads[idx] = { ...normalized, ...lead, id: lead.id || normalized.id };
    for (const key of allLeadDedupeKeys(leads[idx])) byKey.set(key, idx);
  });
  let added = 0, updated = 0, duplicates = 0;
  const saved = [];
  for (const raw of incoming) {
    const lead = normalizeDorkLead(raw, context);
    const keys = allLeadDedupeKeys(lead);
    if (!keys.length) continue;
    const matchKey = keys.find(k => byKey.has(k));
    if (matchKey) {
      const idx = byKey.get(matchKey);
      leads[idx] = mergeDorkLead(leads[idx], lead);
      for (const key of allLeadDedupeKeys(leads[idx])) byKey.set(key, idx);
      updated++;
      duplicates++;
      saved.push(leads[idx]);
    } else {
      leads.push(lead);
      const idx = leads.length - 1;
      for (const key of keys) byKey.set(key, idx);
      added++;
      saved.push(lead);
    }
  }
  const trimmed = leads.slice(-50000);
  writeJsonFile(DORK_LEADS_FILE, trimmed);
  return { added, updated, duplicates, total: trimmed.length, leads: saved };
}

function readCampaigns() { return readJsonFile(CAMPAIGNS_FILE, []); }
function writeCampaigns(campaigns) { writeJsonFile(CAMPAIGNS_FILE, campaigns); }
function saveCampaign(campaign) {
  const campaigns = readCampaigns();
  const idx = campaigns.findIndex(c => c.id === campaign.id);
  campaign.updatedAt = new Date().toISOString();
  if (idx >= 0) campaigns[idx] = campaign; else campaigns.unshift(campaign);
  writeCampaigns(campaigns.slice(0, 200));
  return campaign;
}
function getCampaign(id) { return readCampaigns().find(c => c.id === id); }
function logCampaign(campaign, message) {
  campaign.logs = Array.isArray(campaign.logs) ? campaign.logs : [];
  campaign.logs.push({ at: new Date().toISOString(), message });
  campaign.logs = campaign.logs.slice(-80);
  saveCampaign(campaign);
  console.log('[Cloud Campaign]', campaign.id, message);
}

function buildSearchQuery(signal, settings) {
  let q = String(signal || '').trim();
  q = q.replace(/\{industry\}/gi, settings.industry || '').replace(/\{location\}/gi, settings.location || '');
  if (!q && settings.industry) q = `"${settings.industry}" "${settings.location || ''}" ("email" OR "contact" OR "@gmail.com")`;
  return q.trim();
}
function htmlDecode(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function extractTitle(html, fallback) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlDecode(m[1]).replace(/\s+/g, ' ').trim().slice(0, 120) : fallback;
}
function decodePossiblyBingRedirect(raw) {
  let value = htmlDecode(String(raw || '').trim());
  if (!value) return '';

  // Bing frequently returns result anchors as /ck/a redirect URLs. The real URL is
  // stored in the `u` parameter as base64/url-safe-base64 and often prefixed by `a1`.
  // If we do not decode this, the runner filters the bing.com redirect out and ends
  // campaigns with 0 discovered URLs.
  try {
    const url = new URL(value, 'https://www.bing.com');
    const isBingRedirect = /(^|\.)bing\.com$/i.test(url.hostname) && /\/ck\/a/i.test(url.pathname);
    if (isBingRedirect) {
      let encoded = url.searchParams.get('u') || url.searchParams.get('url') || url.searchParams.get('r') || '';
      encoded = htmlDecode(encoded).trim();
      if (encoded.startsWith('a1')) encoded = encoded.slice(2);
      if (encoded) {
        // URL-safe base64 → normal base64.
        let b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const decoded = Buffer.from(b64, 'base64').toString('utf8').trim();
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    }
  } catch {}

  // Sometimes Bing wraps the URL in a normal query parameter on non-/ck links.
  try {
    const url = new URL(value, 'https://www.bing.com');
    const candidate = url.searchParams.get('u') || url.searchParams.get('url') || url.searchParams.get('r');
    if (candidate && /^https?:\/\//i.test(candidate)) return candidate;
  } catch {}

  return value;
}

function isBlockedOrConsentPage(html) {
  const text = String(html || '').toLowerCase();
  return text.includes('captcha') || text.includes('unusual traffic') || text.includes('verify you are human') || text.includes('consent');
}

function filterSearchCandidateUrls(values) {
  return Array.from(values || [])
    .map(u => normalizeUrl(u))
    .filter(u => /^https?:\/\//i.test(u))
    .filter(u => !/(^https?:\/\/([^\/]+\.)?(bing|microsoft|msn|live)\.)/i.test(u))
    .filter(u => !/\/search\?|\/images\/|\/videos\/|\/maps\?|\/translator\?|\/account\//i.test(u))
    .filter(u => !/\.(jpg|jpeg|png|gif|webp|svg|css|js|ico|woff2?|pdf)(\?|$)/i.test(u));
}

function extractBingUrls(html) {
  const urls = new Set();
  let m;

  // Primary Bing organic result blocks.
  const blockRegex = /<li[^>]+class=["'][^"']*b_algo[^"']*["'][\s\S]*?<h2[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["']/gi;
  while ((m = blockRegex.exec(html))) urls.add(decodePossiblyBingRedirect(m[1]));

  // Newer Bing variants sometimes use different attributes.
  const hrefRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  while ((m = hrefRegex.exec(html))) urls.add(decodePossiblyBingRedirect(m[1]));

  const dataUrlRegex = /data-(?:url|href)=["']([^"']+)["']/gi;
  while ((m = dataUrlRegex.exec(html))) urls.add(decodePossiblyBingRedirect(m[1]));

  // Some Bing result payloads contain escaped URLs inside JSON blobs.
  const jsonUrlRegex = /https?:\/\/[^"'<>\s]+/gi;
  while ((m = jsonUrlRegex.exec(html))) urls.add(decodePossiblyBingRedirect(m[0].replace(/\\\//g, '/')));

  return filterSearchCandidateUrls(urls).slice(0, 150);
}

function extractBingRssUrls(xml) {
  const urls = new Set();
  let m;
  const itemRegex = /<item[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<\/item>/gi;
  while ((m = itemRegex.exec(xml))) urls.add(decodePossiblyBingRedirect(htmlDecode(m[1]).trim()));

  // Backup: any link that appears after an item title.
  const linkRegex = /<link>(https?:[^<]+)<\/link>/gi;
  while ((m = linkRegex.exec(xml))) urls.add(decodePossiblyBingRedirect(htmlDecode(m[1]).trim()));

  return filterSearchCandidateUrls(urls).slice(0, 150);
}

async function searchBingUrls(query, limit = 30) {
  const urls = [];
  const seen = new Set();
  const safeLimit = Math.max(1, Math.min(100, parseInt(limit || 30, 10)));
  let emptyPages = 0;

  function addFound(found) {
    for (const u of found) {
      const key = normalizeUrl(u).replace(/\/$/, '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      urls.push(u);
      if (urls.length >= safeLimit) break;
    }
  }

  // RSS is often easier for server-side runners than parsing Bing's dynamic HTML.
  for (let first = 1; urls.length < safeLimit && first <= 91; first += 10) {
    const rssUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10&first=${first}&mkt=en-US&setlang=en-US&ensearch=1&format=rss`;
    const rss = await fetchPage(rssUrl, 15000);
    const found = extractBingRssUrls(rss);
    addFound(found);
    if (!found.length) break;
    await new Promise(r => setTimeout(r, 500));
  }

  // HTML fallback / supplement.
  for (let first = 1; urls.length < safeLimit && first <= 91; first += 10) {
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10&first=${first}&mkt=en-US&setlang=en-US&ensearch=1`;
    const html = await fetchPage(searchUrl, 15000);
    const found = extractBingUrls(html);
    addFound(found);
    if (!found.length) {
      emptyPages++;
      if (emptyPages >= 2 || isBlockedOrConsentPage(html)) break;
    } else {
      emptyPages = 0;
    }
    await new Promise(r => setTimeout(r, 800));
  }
  return urls.slice(0, safeLimit);
}

async function debugSearchBing(query, limit = 10) {
  const safeLimit = Math.max(1, Math.min(50, parseInt(limit || 10, 10)));
  const htmlUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10&first=1&mkt=en-US&setlang=en-US&ensearch=1`;
  const rssUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10&first=1&mkt=en-US&setlang=en-US&ensearch=1&format=rss`;
  const [htmlRes, rssRes] = await Promise.all([fetchPageDetailed(htmlUrl, 15000), fetchPageDetailed(rssUrl, 15000)]);
  const htmlUrls = extractBingUrls(htmlRes.text || '');
  const rssUrls = extractBingRssUrls(rssRes.text || '');
  const combined = [];
  const seen = new Set();
  [...rssUrls, ...htmlUrls].forEach(u => {
    const k = normalizeUrl(u).replace(/\/$/, '').toLowerCase();
    if (!seen.has(k)) { seen.add(k); combined.push(u); }
  });
  return {
    query,
    htmlStatus: htmlRes.status,
    htmlLength: htmlRes.length,
    htmlBlocked: isBlockedOrConsentPage(htmlRes.text || ''),
    htmlError: htmlRes.error,
    rssStatus: rssRes.status,
    rssLength: rssRes.length,
    rssBlocked: isBlockedOrConsentPage(rssRes.text || ''),
    rssError: rssRes.error,
    htmlUrlsFound: htmlUrls.length,
    rssUrlsFound: rssUrls.length,
    combinedUrlsFound: combined.length,
    sampleUrls: combined.slice(0, safeLimit),
    searchHtmlEmails: cleanEmails(extractEmails(htmlRes.text || '')).slice(0, 10),
    rssEmails: cleanEmails(extractEmails(rssRes.text || '')).slice(0, 10),
  };
}

function organicUrlsFromSerpApiPayload(payload) {
  const urls = new Set();
  const organic = Array.isArray(payload?.organic_results) ? payload.organic_results : [];
  for (const item of organic) {
    if (item && item.link) urls.add(String(item.link));
    if (item && item.redirect_link) urls.add(String(item.redirect_link));
  }
  return filterSearchCandidateUrls(urls);
}

function organicUrlsFromGoogleCsePayload(payload) {
  const urls = new Set();
  const items = Array.isArray(payload?.items) ? payload.items : [];
  for (const item of items) if (item && item.link) urls.add(String(item.link));
  return filterSearchCandidateUrls(urls);
}

async function searchSerpApiUrls(query, limit = 30) {
  if (!SERPAPI_API_KEY) return [];
  const urls = [];
  const seen = new Set();
  const safeLimit = Math.max(1, Math.min(100, parseInt(limit || 30, 10)));
  for (let start = 0; urls.length < safeLimit && start <= 90; start += 10) {
    const apiUrl = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&num=10&start=${start}&api_key=${encodeURIComponent(SERPAPI_API_KEY)}`;
    const detail = await fetchPageDetailed(apiUrl, 20000);
    if (!detail.ok || !detail.text) break;
    let payload = {};
    try { payload = JSON.parse(detail.text); } catch { break; }
    const found = organicUrlsFromSerpApiPayload(payload);
    if (!found.length) break;
    for (const u of found) {
      const key = normalizeUrl(u).replace(/\/$/, '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      urls.push(u);
      if (urls.length >= safeLimit) break;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return urls.slice(0, safeLimit);
}

async function searchGoogleCseUrls(query, limit = 30) {
  if (!GOOGLE_CSE_API_KEY || !GOOGLE_CSE_CX) return [];
  const urls = [];
  const seen = new Set();
  const safeLimit = Math.max(1, Math.min(100, parseInt(limit || 30, 10)));
  for (let start = 1; urls.length < safeLimit && start <= 91; start += 10) {
    const apiUrl = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(GOOGLE_CSE_API_KEY)}&cx=${encodeURIComponent(GOOGLE_CSE_CX)}&q=${encodeURIComponent(query)}&num=10&start=${start}`;
    const detail = await fetchPageDetailed(apiUrl, 20000);
    if (!detail.ok || !detail.text) break;
    let payload = {};
    try { payload = JSON.parse(detail.text); } catch { break; }
    const found = organicUrlsFromGoogleCsePayload(payload);
    if (!found.length) break;
    for (const u of found) {
      const key = normalizeUrl(u).replace(/\/$/, '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      urls.push(u);
      if (urls.length >= safeLimit) break;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return urls.slice(0, safeLimit);
}

function resolveSearchProvider(engine) {
  const requested = String(engine || SEARCH_PROVIDER || 'auto').toLowerCase().replace(/-/g, '_');
  if (['google', 'google_cse', 'cse'].includes(requested)) return 'google_cse';
  if (['serpapi', 'google_serpapi'].includes(requested)) return 'serpapi';
  if (['bing', 'bing_rss'].includes(requested)) return 'bing';
  return 'auto';
}

async function searchUrlsWithProvider(query, limit = 30, engine = 'auto') {
  const provider = resolveSearchProvider(engine);
  const tried = [];
  async function run(providerName) {
    if (providerName === 'google_cse') {
      if (!GOOGLE_CSE_API_KEY || !GOOGLE_CSE_CX) return { urls: [], provider: 'google_cse', skipped: 'missing GOOGLE_CSE_API_KEY or GOOGLE_CSE_CX' };
      return { urls: await searchGoogleCseUrls(query, limit), provider: 'google_cse' };
    }
    if (providerName === 'serpapi') {
      if (!SERPAPI_API_KEY) return { urls: [], provider: 'serpapi', skipped: 'missing SERPAPI_API_KEY' };
      return { urls: await searchSerpApiUrls(query, limit), provider: 'serpapi' };
    }
    return { urls: await searchBingUrls(query, limit), provider: 'bing' };
  }

  if (provider !== 'auto') {
    const result = await run(provider);
    tried.push({ provider: result.provider, found: result.urls.length, skipped: result.skipped || '' });
    return { urls: result.urls, provider: result.provider, tried };
  }

  // Auto mode: Bing first because it has an RSS endpoint; then Google CSE/SerpAPI only if keys exist.
  for (const providerName of ['bing', 'google_cse', 'serpapi']) {
    const result = await run(providerName);
    tried.push({ provider: result.provider, found: result.urls.length, skipped: result.skipped || '' });
    if (result.urls.length) return { urls: result.urls, provider: result.provider, tried };
  }
  return { urls: [], provider: 'none', tried };
}

async function debugSearchAny(query, limit = 10, engine = 'auto') {
  const bingDebug = await debugSearchBing(query, limit);
  const cseUrls = GOOGLE_CSE_API_KEY && GOOGLE_CSE_CX ? await searchGoogleCseUrls(query, limit) : [];
  const serpUrls = SERPAPI_API_KEY ? await searchSerpApiUrls(query, limit) : [];
  const selected = await searchUrlsWithProvider(query, limit, engine);
  return {
    query,
    requestedProvider: resolveSearchProvider(engine),
    selectedProvider: selected.provider,
    tried: selected.tried,
    bing: bingDebug,
    googleCse: { enabled: !!(GOOGLE_CSE_API_KEY && GOOGLE_CSE_CX), urlsFound: cseUrls.length, sampleUrls: cseUrls.slice(0, limit) },
    serpApi: { enabled: !!SERPAPI_API_KEY, urlsFound: serpUrls.length, sampleUrls: serpUrls.slice(0, limit) },
    combinedUrlsFound: selected.urls.length,
    sampleUrls: selected.urls.slice(0, limit),
  };
}


function createCampaignPayload(body = {}) {
  const settings = normalizeDorkSettings(body.settings || body || {});
  const maxEmailsRaw = parseInt(body.maxEmails || body.max_emails || body.targetEmails || body.target_emails || 1000, 10);
  const maxPagesRaw = parseInt(body.maxPages || body.max_pages || (settings.signals.length * settings.resultsPerSignal), 10);
  return {
    id: body.id || 'camp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    name: body.name || `${settings.industry || 'Airtable prospects'} in ${settings.location || 'selected market'}`,
    type: 'cloud_dorking',
    status: 'queued',
    industry: settings.industry,
    location: settings.location,
    signals: settings.signals,
    resultsPerSignal: settings.resultsPerSignal,
    delayBetweenPages: settings.delayBetweenPages,
    engine: settings.engine || 'bing',
    maxEmails: Math.max(1, Math.min(10000, Number.isFinite(maxEmailsRaw) ? maxEmailsRaw : 1000)),
    maxPages: Math.max(1, Math.min(50000, Number.isFinite(maxPagesRaw) ? maxPagesRaw : settings.signals.length * settings.resultsPerSignal)),
    verifyWhileRunning: !!body.verifyWhileRunning,
    createdAt: new Date().toISOString(),
    startedAt: '',
    finishedAt: '',
    updatedAt: new Date().toISOString(),
    totalSignals: settings.signals.length,
    processedSignals: 0,
    totalUrlsDiscovered: 0,
    pagesChecked: 0,
    emailsFound: 0,
    newEmailsAdded: 0,
    duplicatesSkipped: 0,
    errors: 0,
    currentSignal: '',
    currentQuery: '',
    currentUrl: '',
    stopRequested: false,
    logs: [],
  };
}

async function runCloudCampaign(campaignId) {
  if (runningCampaigns.has(campaignId)) return;
  let campaign = getCampaign(campaignId);
  if (!campaign) return;
  runningCampaigns.set(campaignId, { startedAt: Date.now() });
  campaign.status = 'running';
  campaign.startedAt = campaign.startedAt || new Date().toISOString();
  campaign.stopRequested = false;
  saveCampaign(campaign);
  logCampaign(campaign, 'Campaign started.');

  try {
    for (let sIndex = 0; sIndex < campaign.signals.length; sIndex++) {
      campaign = getCampaign(campaignId) || campaign;
      if (campaign.stopRequested || campaign.status === 'stopping') break;
      const signal = campaign.signals[sIndex];
      const query = buildSearchQuery(signal, campaign);
      campaign.currentSignal = String(signal);
      campaign.currentQuery = query;
      saveCampaign(campaign);
      logCampaign(campaign, `Searching signal ${sIndex + 1}/${campaign.signals.length}: ${query}`);

      let urls = [];
      let searchProvider = 'none';
      try {
        const searchResult = await searchUrlsWithProvider(query, campaign.resultsPerSignal, campaign.engine || SEARCH_PROVIDER || 'auto');
        urls = searchResult.urls || [];
        searchProvider = searchResult.provider || 'none';
        campaign.lastSearchProvider = searchProvider;
        campaign.lastSearchTried = searchResult.tried || [];
        logCampaign(campaign, `Search providers tried: ${(searchResult.tried || []).map(t => `${t.provider}:${t.found}${t.skipped ? ' skipped=' + t.skipped : ''}`).join(', ')}`);
      }
      catch(e) { campaign.errors++; logCampaign(campaign, 'Search failed: ' + e.message); }
      campaign.totalUrlsDiscovered += urls.length;
      saveCampaign(campaign);
      logCampaign(campaign, `Discovered ${urls.length} destination URLs for this signal using ${searchProvider}.`);
      if (!urls.length) {
        logCampaign(campaign, 'No destination URLs found. Check /debug-search. If Bing returns 0, set SEARCH_PROVIDER=google_cse with GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX, or SEARCH_PROVIDER=serpapi with SERPAPI_API_KEY.');
      }

      for (const url of urls) {
        campaign = getCampaign(campaignId) || campaign;
        if (campaign.stopRequested || campaign.status === 'stopping') break;
        if (campaign.pagesChecked >= campaign.maxPages || campaign.newEmailsAdded >= campaign.maxEmails) break;
        campaign.currentUrl = url;
        saveCampaign(campaign);

        try {
          const html = await fetchPage(url, 12000);
          const direct = cleanEmails(extractEmails(html));
          let crawl = { emails: [] };
          if (direct.length < 1) crawl = await crawlSiteForEmail(url);
          const emails = cleanEmails(new Set([...(direct || []), ...((crawl && crawl.emails) || [])]));
          campaign.pagesChecked++;
          campaign.emailsFound += emails.length;

          if (emails.length) {
            logCampaign(campaign, `Found ${emails.length} email(s) on ${url}`);
            const title = extractTitle(html, rootDomain(url));
            const leadRows = emails.map(email => ({
              name: title,
              email,
              emails: [email],
              website: url,
              industry: campaign.industry,
              location: campaign.location,
              sourceQuery: query,
              sourceSignal: String(signal),
              sourceUrl: url,
              campaignId: campaign.id,
              source: 'cloud_campaign',
              sourceEngine: searchProvider,
            }));

            if (campaign.verifyWhileRunning) {
              for (let i = 0; i < leadRows.length; i++) {
                const result = await verifyEmailAddress(leadRows[i].email);
                leadRows[i] = applyVerificationToLead(leadRows[i], result);
              }
            }

            const saved = saveDorkLeadBatch(leadRows, { campaignId: campaign.id, industry: campaign.industry, location: campaign.location, sourceQuery: query, sourceSignal: String(signal), source: 'cloud_campaign' });
            campaign.newEmailsAdded += saved.added;
            campaign.duplicatesSkipped += saved.duplicates;
          }
        } catch(e) {
          campaign.errors++;
          logCampaign(campaign, `Page failed: ${url} — ${e.message}`);
        }

        saveCampaign(campaign);
        const delay = Math.max(250, Math.min(60000, Number(campaign.delayBetweenPages || 5000)));
        await new Promise(r => setTimeout(r, delay));
      }
      campaign.processedSignals = sIndex + 1;
      saveCampaign(campaign);
      if (campaign.pagesChecked >= campaign.maxPages || campaign.newEmailsAdded >= campaign.maxEmails) break;
    }

    campaign = getCampaign(campaignId) || campaign;
    if (campaign.stopRequested || campaign.status === 'stopping') campaign.status = 'stopped';
    else campaign.status = 'completed';
    campaign.finishedAt = new Date().toISOString();
    campaign.currentUrl = '';
    saveCampaign(campaign);
    logCampaign(campaign, `Campaign ${campaign.status}. Added ${campaign.newEmailsAdded} new unique emails. Duplicates skipped/merged: ${campaign.duplicatesSkipped}.`);
  } catch(e) {
    campaign = getCampaign(campaignId) || campaign;
    campaign.status = 'failed';
    campaign.finishedAt = new Date().toISOString();
    campaign.errors++;
    logCampaign(campaign, 'Campaign failed: ' + e.message);
  } finally {
    runningCampaigns.delete(campaignId);
  }
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({
  status: 'ok', service: 'Scout Backend v4.5 Gmail Connection Diagnostics', timestamp: new Date().toISOString(),
  hasGmapsKey: !!GMAPS_KEY,
  browserGoogleMapsImport: { enabled: true, requiresGoogleApiKey: false, endpoint: '/leads/import-google-maps-browser' },
  emailVerifier: {
    provider: EMAIL_VERIFIER_PROVIDER || 'basic_mx',
    hasProviderKey: !!getVerifierProviderKey(EMAIL_VERIFIER_PROVIDER),
  },
  searchProvider: { default: SEARCH_PROVIDER || 'auto', hasSerpApiKey: !!SERPAPI_API_KEY, hasGoogleCseKey: !!GOOGLE_CSE_API_KEY, hasGoogleCseCx: !!GOOGLE_CSE_CX },
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
  const incoming = Array.isArray(req.body?.leads) ? req.body.leads : (req.body?.lead ? [req.body.lead] : [req.body].filter(x => x && (x.email || x.website || x.url)));
  if (!incoming.length) return res.status(400).json({ error: 'lead or leads required' });
  const result = saveDorkLeadBatch(incoming, { source: 'extension_or_app' });
  res.json({ success: true, ...result });
});

app.get('/dork-leads', (req, res) => {
  let leads = readJsonFile(DORK_LEADS_FILE, []);
  const campaignId = String(req.query.campaignId || req.query.campaign_id || '');
  const since = String(req.query.since || req.query.updatedSince || '');
  const status = String(req.query.status || '').toLowerCase();
  if (campaignId) leads = leads.filter(l => l.campaignId === campaignId || (Array.isArray(l.campaignIds) && l.campaignIds.includes(campaignId)));
  if (since) leads = leads.filter(l => String(l.lastSeenAt || l.updatedAt || l.addedAt || '') > since);
  if (status) leads = leads.filter(l => leadMatchesStatus(l, status));
  leads = leads.sort((a,b) => String(b.lastSeenAt || b.updatedAt || b.addedAt || '').localeCompare(String(a.lastSeenAt || a.updatedAt || a.addedAt || '')));
  const limit = Math.max(1, Math.min(50000, parseInt(req.query.limit || leads.length || 1000, 10)));
  const out = leads.slice(0, limit);
  if (req.query.format === 'csv') {
    const headers = ['name','email','emails','website','industry','location','sourceQuery','sourceSignal','sourceQueries','sourceSignals','campaignIds','addedAt','lastSeenAt','verificationStatus','verificationScore','verificationProvider','verificationReason','verifiedAt','readyToContact'];
    const lines = [headers.map(csvEscape).join(',')];
    out.forEach(l => lines.push(headers.map(h => csvEscape(Array.isArray(l[h]) ? l[h].join('; ') : (h === 'emails' ? (l.emails || []).join('; ') : l[h]))).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="dork-leads.csv"');
    return res.send('\ufeff' + lines.join('\r\n'));
  }
  res.json({ success: true, total: leads.length, returned: out.length, leads: out, serverTime: new Date().toISOString() });
});



// ── CLOUD CAMPAIGN ROUTES ───────────────────────────────────────────────────


app.get('/debug-search', async (req, res) => {
  try {
    const savedSettings = readJsonFile(DORK_SETTINGS_FILE, normalizeDorkSettings({}));
    const rawSignal = req.query.signal || savedSettings.signals?.[0] || '';
    const query = String(req.query.q || req.query.query || (rawSignal ? buildSearchQuery(rawSignal, savedSettings) : '')).trim();
    if (!query) return res.status(400).json({ error: 'query required. Pass ?q=... or save dork settings first.' });
    const debug = await debugSearchAny(query, req.query.limit || 10, req.query.engine || req.query.provider || SEARCH_PROVIDER || 'auto');
    res.json({ success: true, service: 'Scout Backend v3.8', debug });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message || String(e) });
  }
});

app.post('/debug-extract', async (req, res) => {
  try {
    const url = String(req.body?.url || req.query.url || '').trim();
    if (!url) return res.status(400).json({ error: 'url required' });
    const html = await fetchPage(url, 15000);
    const direct = cleanEmails(extractEmails(html));
    let crawl = { emails: [], phones: [], reached: 0 };
    if (!direct.length) crawl = await crawlSiteForEmail(url);
    res.json({ success: true, url, htmlLength: html.length, directEmails: direct, crawl, title: extractTitle(html, rootDomain(url)) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message || String(e) });
  }
});

app.post('/campaigns/start', (req, res) => {
  const campaign = createCampaignPayload(req.body || {});
  if (!campaign.signals.length) return res.status(400).json({ error: 'signals required. Save dork settings or pass signals[] first.' });
  saveCampaign(campaign);
  setTimeout(() => runCloudCampaign(campaign.id), 50);
  res.json({ success: true, campaign });
});

app.post('/dork-campaigns/start', (req, res) => {
  const campaign = createCampaignPayload(req.body || {});
  if (!campaign.signals.length) return res.status(400).json({ error: 'signals required. Save dork settings or pass signals[] first.' });
  saveCampaign(campaign);
  setTimeout(() => runCloudCampaign(campaign.id), 50);
  res.json({ success: true, campaign });
});

app.get('/campaigns', (req, res) => {
  const campaigns = readCampaigns().sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.json({ success: true, total: campaigns.length, running: Array.from(runningCampaigns.keys()), campaigns });
});

app.get('/campaigns/:id', (req, res) => {
  const campaign = getCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'campaign not found' });
  res.json({ success: true, campaign, isRunning: runningCampaigns.has(req.params.id), serverTime: new Date().toISOString() });
});

app.post('/campaigns/:id/stop', (req, res) => {
  const campaign = getCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'campaign not found' });
  campaign.stopRequested = true;
  campaign.status = runningCampaigns.has(req.params.id) ? 'stopping' : 'stopped';
  saveCampaign(campaign);
  res.json({ success: true, campaign });
});

app.get('/campaigns/:id/leads', (req, res) => {
  req.query.campaignId = req.params.id;
  let leads = readJsonFile(DORK_LEADS_FILE, []).filter(l => l.campaignId === req.params.id || (Array.isArray(l.campaignIds) && l.campaignIds.includes(req.params.id)));
  const since = String(req.query.since || req.query.updatedSince || '');
  if (since) leads = leads.filter(l => String(l.lastSeenAt || l.updatedAt || l.addedAt || '') > since);
  leads = leads.sort((a,b) => String(b.lastSeenAt || b.updatedAt || b.addedAt || '').localeCompare(String(a.lastSeenAt || a.updatedAt || a.addedAt || '')));
  const limit = Math.max(1, Math.min(50000, parseInt(req.query.limit || leads.length || 1000, 10)));
  const out = leads.slice(0, limit);
  if (req.query.format === 'csv') {
    const headers = ['name','email','website','industry','location','verificationStatus','readyToContact','sourceQuery','sourceSignal','addedAt','lastSeenAt'];
    const lines = [headers.map(csvEscape).join(',')];
    out.forEach(l => lines.push(headers.map(h => csvEscape(l[h])).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="campaign-${req.params.id}-leads.csv"`);
    return res.send('\ufeff' + lines.join('\r\n'));
  }
  res.json({ success: true, campaignId: req.params.id, total: leads.length, returned: out.length, leads: out, serverTime: new Date().toISOString() });
});

app.post('/campaigns/:id/verify-new', async (req, res) => {
  const campaign = getCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'campaign not found' });
  const leads = readJsonFile(DORK_LEADS_FILE, []);
  const limit = Math.max(1, Math.min(500, parseInt(req.body?.limit || 100, 10)));
  let checked = 0;
  for (let i = 0; i < leads.length && checked < limit; i++) {
    const l = leads[i];
    const inCampaign = l.campaignId === req.params.id || (Array.isArray(l.campaignIds) && l.campaignIds.includes(req.params.id));
    if (!inCampaign || !l.email) continue;
    if (l.verificationStatus && l.verificationStatus !== 'needs_verification') continue;
    const result = await verifyEmailAddress(l.email, req.body?.provider);
    leads[i] = applyVerificationToLead(l, result);
    checked++;
    await new Promise(r => setTimeout(r, Number(req.body?.delayMs || 150)));
  }
  writeJsonFile(DORK_LEADS_FILE, leads);
  res.json({ success: true, checked, campaignId: req.params.id });
});

// ── EMAIL VERIFICATION ROUTES ────────────────────────────────────────────────

app.get('/verifier-config', (req, res) => {
  const provider = String(req.query.provider || EMAIL_VERIFIER_PROVIDER || '').toLowerCase();
  res.json({
    success: true,
    defaultProvider: EMAIL_VERIFIER_PROVIDER || 'basic_mx',
    requestedProvider: provider || 'basic_mx',
    hasProviderKey: !!getVerifierProviderKey(provider),
    supportedProviders: ['basic_mx','zerobounce','abstract','hunter','neverbounce','kickbox'],
    note: getVerifierProviderKey(provider) ? 'Mailbox-level verification enabled.' : 'Using built-in format + DNS/MX verification only until you add a verifier API key.'
  });
});

app.post('/verify-email', async (req, res) => {
  const email = req.body?.email;
  if (!email) return res.status(400).json({ error: 'email required' });
  const result = await verifyEmailAddress(email, req.body?.provider);
  res.json({ success: true, result });
});

app.post('/batch-verify-emails', async (req, res) => {
  const emails = Array.isArray(req.body?.emails)
    ? req.body.emails
    : Array.isArray(req.body?.leads)
      ? req.body.leads.map(l => l.email || (Array.isArray(l.emails) ? l.emails[0] : '')).filter(Boolean)
      : [];
  if (!emails.length) return res.status(400).json({ error: 'emails array or leads array required' });
  const unique = Array.from(new Set(emails.map(normalizeEmail).filter(Boolean))).slice(0, 500);
  const results = [];
  for (const email of unique) {
    results.push(await verifyEmailAddress(email, req.body?.provider));
    await new Promise(r => setTimeout(r, Number(req.body?.delayMs || 150)));
  }
  res.json({ success: true, total: results.length, results });
});

app.post('/verify-dork-leads', async (req, res) => {
  const leads = readJsonFile(DORK_LEADS_FILE, []);
  const limit = Math.max(1, Math.min(500, parseInt(req.body?.limit || 100, 10)));
  const force = !!req.body?.force;
  let checked = 0;
  for (let i = 0; i < leads.length && checked < limit; i++) {
    const lead = leads[i];
    const email = lead.email || (Array.isArray(lead.emails) ? lead.emails[0] : '');
    if (!email) continue;
    if (!force && lead.verificationStatus && lead.verificationStatus !== 'needs_verification') continue;
    const result = await verifyEmailAddress(email, req.body?.provider);
    leads[i] = applyVerificationToLead(lead, result);
    checked++;
    await new Promise(r => setTimeout(r, Number(req.body?.delayMs || 150)));
  }
  writeJsonFile(DORK_LEADS_FILE, leads);
  const summary = leads.reduce((a,l) => { const k = l.readyToContact ? 'ready' : (l.verificationStatus || 'needs_verification'); a[k] = (a[k] || 0) + 1; return a; }, {});
  res.json({ success: true, checked, total: leads.length, summary });
});

app.post('/import-verification-results', (req, res) => {
  const results = Array.isArray(req.body?.results) ? req.body.results : [];
  if (!results.length) return res.status(400).json({ error: 'results array required' });
  const leads = readJsonFile(DORK_LEADS_FILE, []);
  const map = new Map(results.map(r => [normalizeEmail(r.email), r]));
  let updated = 0;
  for (let i = 0; i < leads.length; i++) {
    const email = normalizeEmail(leads[i].email || (Array.isArray(leads[i].emails) ? leads[i].emails[0] : ''));
    const r = map.get(email);
    if (!r) continue;
    const status = String(r.status || r.verificationStatus || r.result || '').toLowerCase().replace(/\s+/g, '_');
    leads[i] = {
      ...leads[i],
      verificationStatus: ['valid','risky','catch_all','invalid','unknown'].includes(status) ? status : (status === 'deliverable' ? 'valid' : status || 'unknown'),
      verificationScore: r.score ?? r.verificationScore ?? '',
      verificationProvider: r.provider || r.verificationProvider || 'imported',
      verificationReason: r.reason || r.verificationReason || r.providerReason || '',
      verifiedAt: r.verifiedAt || new Date().toISOString(),
      readyToContact: ['valid','deliverable'].includes(status) && Number(r.score ?? 80) >= 70,
    };
    updated++;
  }
  writeJsonFile(DORK_LEADS_FILE, leads);
  res.json({ success: true, updated, total: leads.length });
});

app.get('/verified-leads', (req, res) => {
  const status = String(req.query.status || '').toLowerCase();
  const leads = readJsonFile(DORK_LEADS_FILE, []).filter(l => leadMatchesStatus(l, status));
  if (req.query.format === 'csv') {
    const headers = ['name','email','website','industry','location','verificationStatus','verificationScore','verificationProvider','verificationReason','readyToContact','sourceQuery','addedAt','verifiedAt'];
    const lines = [headers.map(csvEscape).join(',')];
    leads.forEach(l => lines.push(headers.map(h => csvEscape(l[h])).join(',')));
    const fileName = status === 'ready' ? 'ready-to-contact-leads.csv' : `verified-leads-${status || 'all'}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send('\ufeff' + lines.join('\r\n'));
  }
  res.json({ success: true, total: leads.length, leads });
});


// ── UNIFIED LEAD INTELLIGENCE + SMART MESSAGING ─────────────────────────────

const DEFAULT_MESSAGE_TEMPLATES = [
  {
    id: 'maps_rich_airtable_ops',
    name: 'Google Maps rich lead - operations pain',
    sourceFit: ['google_maps'],
    priority: 100,
    subject: 'Airtable system for {name}',
    body: 'Hi {name}, I saw your {industry} business in {location} has {rating} stars from {reviews} reviews. I help businesses replace messy spreadsheets with a simple Airtable system for leads, bookings, follow-ups, and staff tasks. Would it be useful if I showed you a simple setup for {name}?',
  },
  {
    id: 'maps_standard_airtable',
    name: 'Google Maps standard lead',
    sourceFit: ['google_maps'],
    priority: 90,
    subject: 'Quick Airtable idea for {name}',
    body: 'Hi {name}, I came across your {industry} business in {location}. I help businesses organize leads, clients, bookings, follow-ups, and daily work inside Airtable so nothing gets lost in spreadsheets or WhatsApp. Would you like me to send a quick example for {name}?',
  },
  {
    id: 'website_dorking_airtable',
    name: 'Website/dorking lead',
    sourceFit: ['cloud_campaign', 'dorking', 'extension_or_app'],
    priority: 80,
    subject: 'Airtable workflow idea for {name}',
    body: 'Hi {name}, I came across your website and noticed you offer {industry} services in {location}. I build Airtable systems that help businesses track leads, clients, bookings, tasks, and follow-ups in one simple dashboard. Is this something you would like to improve at {name}?',
  },
  {
    id: 'website_light_airtable',
    name: 'Website lead - light personalization',
    sourceFit: ['cloud_campaign', 'dorking', 'extension_or_app', 'uploaded'],
    priority: 70,
    subject: 'Organizing {industry} leads in Airtable',
    body: 'Hi, I help {industry} businesses in {location} build simple Airtable systems for lead tracking, customer follow-up, bookings, and daily operations. Would you be open to seeing a quick example?',
  },
  {
    id: 'email_only_safe',
    name: 'Email-only safe message',
    sourceFit: ['uploaded'],
    priority: 50,
    subject: 'Airtable system for your operations',
    body: 'Hi, I build simple Airtable systems that help service businesses track leads, clients, follow-ups, tasks, and operations in one place. Would you be open to seeing a quick example?',
  },
];

const SHORTCODE_FIELDS = {
  email: ['email'],
  name: ['name', 'businessName', 'companyName'],
  business_name: ['businessName', 'name', 'companyName'],
  company: ['companyName', 'businessName', 'name'],
  industry: ['industry', 'category'],
  category: ['category', 'industry'],
  location: ['location', 'city', 'address'],
  city: ['city', 'location'],
  address: ['address'],
  website: ['website'],
  domain: ['domain'],
  phone: ['phone'],
  rating: ['rating'],
  reviews: ['reviews'],
  source: ['source'],
  sourceSignal: ['sourceSignal'],
  sourceQuery: ['sourceQuery'],
};

function ensureDefaultTemplates() {
  const existing = readJsonFile(MESSAGE_TEMPLATES_FILE, null);
  if (!Array.isArray(existing) || !existing.length) {
    writeJsonFile(MESSAGE_TEMPLATES_FILE, DEFAULT_MESSAGE_TEMPLATES);
    return DEFAULT_MESSAGE_TEMPLATES;
  }
  return existing;
}

function getLeadValue(lead, code) {
  const keys = SHORTCODE_FIELDS[code] || [code];
  for (const key of keys) {
    const value = lead[key];
    if (value == null) continue;
    if (Array.isArray(value) && value.length) return value.join(', ');
    const clean = String(value).trim();
    if (clean) return clean;
  }
  return '';
}

function getShortcodes(text) {
  const codes = new Set();
  String(text || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_, code) => { codes.add(code); return ''; });
  return Array.from(codes);
}

function templateCodes(template) {
  return Array.from(new Set([...getShortcodes(template.subject), ...getShortcodes(template.body)]));
}

function renderTemplateText(text, lead) {
  const missing = [];
  const rendered = String(text || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (m, code) => {
    const value = getLeadValue(lead, code);
    if (!value) { missing.push(code); return m; }
    return value;
  });
  return { rendered, missing: Array.from(new Set(missing)) };
}

function scoreLead(lead) {
  let score = 0;
  if (lead.email) score += 25;
  if (lead.verificationStatus === 'valid' || lead.readyToContact) score += 30;
  else if (lead.verificationStatus === 'catch_all') score += 15;
  else if (lead.verificationStatus === 'risky' || lead.verificationStatus === 'needs_provider') score += 8;
  else if (lead.verificationStatus === 'invalid') score -= 50;
  if (lead.name || lead.businessName) score += 10;
  if (lead.website) score += 10;
  if (lead.industry || lead.category) score += 8;
  if (lead.location || lead.address) score += 8;
  if (lead.rating) score += 4;
  if (lead.reviews) score += 4;
  if (lead.phone) score += 3;
  if (lead.source === 'google_maps') score += 6;
  if (lead.isDisposable) score -= 50;
  if (lead.verificationStatus === 'invalid') score = 0;
  return Math.max(0, Math.min(100, score));
}

function enrichLeadComputedFields(lead) {
  const normalized = normalizeDorkLead(lead, {});
  normalized.leadScore = Number(lead.leadScore || 0) || scoreLead({ ...normalized, ...lead });
  return { ...normalized, ...lead, leadScore: normalized.leadScore };
}

function templateFitsLead(template, lead) {
  const codes = templateCodes(template);
  const missing = codes.filter(c => !getLeadValue(lead, c));
  const source = String(lead.source || '').toLowerCase();
  const fit = Array.isArray(template.sourceFit) && template.sourceFit.length
    ? template.sourceFit.some(s => source.includes(String(s).toLowerCase()) || String(s).toLowerCase() === 'any')
    : true;
  return { fits: missing.length === 0 && fit, missing, sourceFit: fit, codes };
}

function pickBestTemplateForLead(lead, templates) {
  const usable = [];
  const blocked = [];
  for (const t of templates) {
    const fit = templateFitsLead(t, lead);
    if (fit.fits) usable.push({ template: t, fit }); else blocked.push({ template: t, fit });
  }
  usable.sort((a, b) => Number(b.template.priority || 0) - Number(a.template.priority || 0));
  return { best: usable[0] || null, usable, blocked };
}

function buildMessageForLead(lead, templates) {
  if (!lead.email) {
    return { ready: false, status: 'blocked_missing_email', missingCodes: ['email'], reason: 'Lead has no email address.' };
  }
  if (lead.verificationStatus === 'invalid' || lead.isDisposable) {
    return { ready: false, status: 'blocked_bad_email', missingCodes: [], reason: 'Email is invalid/disposable.' };
  }
  const picked = pickBestTemplateForLead(lead, templates);
  if (!picked.best) {
    const missing = Array.from(new Set(picked.blocked.flatMap(x => x.fit.missing))).slice(0, 20);
    return { ready: false, status: 'blocked_missing_shortcodes', missingCodes: missing, reason: 'No compatible template for available lead data.' };
  }
  const template = picked.best.template;
  const subject = renderTemplateText(template.subject, lead);
  const body = renderTemplateText(template.body, lead);
  const missing = Array.from(new Set([...subject.missing, ...body.missing]));
  if (missing.length) return { ready: false, status: 'blocked_missing_shortcodes', missingCodes: missing, reason: 'Template has missing shortcodes.' };
  return { ready: true, status: 'ready', templateId: template.id, templateName: template.name, subject: subject.rendered, body: body.rendered, missingCodes: [] };
}

function parseUploadedEmailsText(text, defaults = {}) {
  const out = [];
  const seen = new Set();
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const emails = cleanEmails(new Set(line.match(/[a-z0-9._%+\-]{1,64}@[a-z0-9.\-]+\.[a-z]{2,}/gi) || []));
    if (!emails.length) continue;
    for (const email of emails) {
      const key = normalizeEmail(email);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        email: key,
        emails: [key],
        name: defaults.name || defaults.businessName || '',
        industry: defaults.industry || '',
        location: defaults.location || '',
        source: 'uploaded',
        importedAt: new Date().toISOString(),
      });
    }
  }
  return out;
}

function readMapCampaigns() { return readJsonFile(MAP_CAMPAIGNS_FILE, []); }
function writeMapCampaigns(campaigns) { writeJsonFile(MAP_CAMPAIGNS_FILE, campaigns); }
function saveMapCampaign(campaign) {
  const campaigns = readMapCampaigns();
  const idx = campaigns.findIndex(c => c.id === campaign.id);
  campaign.updatedAt = new Date().toISOString();
  if (idx >= 0) campaigns[idx] = campaign; else campaigns.unshift(campaign);
  writeMapCampaigns(campaigns.slice(0, 200));
  return campaign;
}
function getMapCampaign(id) { return readMapCampaigns().find(c => c.id === id); }
function logMapCampaign(campaign, message) {
  campaign.logs = Array.isArray(campaign.logs) ? campaign.logs : [];
  campaign.logs.push({ at: new Date().toISOString(), message });
  campaign.logs = campaign.logs.slice(-100);
  saveMapCampaign(campaign);
  console.log('[Maps Campaign]', campaign.id, message);
}

const runningMapCampaigns = new Map();

function normalizeMapsCampaignPayload(body = {}) {
  const industry = String(body.industry || body.category || body.businessType || '').trim();
  const location = String(body.location || body.city || '').trim();
  const targetEmailsRaw = parseInt(body.targetEmails || body.target_emails || body.maxEmails || 100, 10);
  const maxPlacesRaw = parseInt(body.maxPlaces || body.max_places || Math.max(targetEmailsRaw * 3, 40), 10);
  return {
    id: body.id || 'maps_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    name: body.name || `${industry || 'Businesses'} in ${location || 'selected market'}`,
    type: 'google_maps_email_campaign',
    status: 'queued',
    industry,
    location,
    query: String(body.query || `${industry} in ${location}`).trim(),
    targetEmails: Math.max(1, Math.min(10000, Number.isFinite(targetEmailsRaw) ? targetEmailsRaw : 100)),
    maxPlaces: Math.max(1, Math.min(2000, Number.isFinite(maxPlacesRaw) ? maxPlacesRaw : 200)),
    delayBetweenPlaces: Math.max(250, Math.min(60000, parseInt(body.delayBetweenPlaces || body.delay_between_places || 1000, 10) || 1000)),
    verifyWhileRunning: !!body.verifyWhileRunning,
    createdAt: new Date().toISOString(),
    startedAt: '',
    finishedAt: '',
    updatedAt: new Date().toISOString(),
    placesFound: 0,
    placesChecked: 0,
    websitesCrawled: 0,
    emailsFound: 0,
    newEmailsAdded: 0,
    duplicatesSkipped: 0,
    errors: 0,
    currentPlace: '',
    currentWebsite: '',
    stopRequested: false,
    logs: [],
  };
}

async function googlePlacesTextSearch(query, maxPlaces = 60) {
  if (!GMAPS_KEY) throw new Error('GOOGLE_MAPS_API_KEY is not set on backend. Add it in Render environment variables.');
  const places = [];
  let pageToken = '';
  for (let page = 0; page < 3 && places.length < maxPlaces; page++) {
    if (pageToken) await new Promise(r => setTimeout(r, 2200));
    const url = pageToken
      ? `https://maps.googleapis.com/maps/api/place/textsearch/json?pagetoken=${encodeURIComponent(pageToken)}&key=${encodeURIComponent(GMAPS_KEY)}`
      : `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${encodeURIComponent(GMAPS_KEY)}`;
    const r = await axios.get(url, { timeout: 15000, validateStatus: s => s < 500 });
    if (r.data?.status && !['OK','ZERO_RESULTS'].includes(r.data.status)) {
      throw new Error(`Google Places Text Search error: ${r.data.status} ${r.data.error_message || ''}`.trim());
    }
    (r.data?.results || []).forEach(p => places.push(p));
    pageToken = r.data?.next_page_token || '';
    if (!pageToken || r.data?.status === 'ZERO_RESULTS') break;
  }
  return places.slice(0, maxPlaces);
}

async function runGoogleMapsCampaign(campaignId) {
  if (runningMapCampaigns.has(campaignId)) return;
  let campaign = getMapCampaign(campaignId);
  if (!campaign) return;
  runningMapCampaigns.set(campaignId, { startedAt: Date.now() });
  campaign.status = 'running';
  campaign.startedAt = campaign.startedAt || new Date().toISOString();
  saveMapCampaign(campaign);
  logMapCampaign(campaign, 'Google Maps campaign started.');
  try {
    const queries = Array.from(new Set([
      campaign.query,
      `${campaign.industry} near ${campaign.location}`,
      `best ${campaign.industry} ${campaign.location}`,
      `${campaign.industry} services ${campaign.location}`,
    ].map(q => String(q || '').trim()).filter(Boolean)));

    const seenPlaces = new Set();
    for (const query of queries) {
      campaign = getMapCampaign(campaignId) || campaign;
      if (campaign.stopRequested || campaign.status === 'stopping') break;
      logMapCampaign(campaign, `Searching Google Maps: ${query}`);
      let places = [];
      try { places = await googlePlacesTextSearch(query, campaign.maxPlaces); }
      catch (e) { campaign.errors++; logMapCampaign(campaign, e.message); saveMapCampaign(campaign); continue; }
      campaign.placesFound += places.length;
      saveMapCampaign(campaign);

      for (const p of places) {
        campaign = getMapCampaign(campaignId) || campaign;
        if (campaign.stopRequested || campaign.status === 'stopping') break;
        if (campaign.newEmailsAdded >= campaign.targetEmails || campaign.placesChecked >= campaign.maxPlaces) break;
        const pid = p.place_id || '';
        if (pid && seenPlaces.has(pid)) continue;
        if (pid) seenPlaces.add(pid);
        campaign.currentPlace = p.name || pid || '';
        saveMapCampaign(campaign);

        try {
          const details = pid ? await getPlaceDetails(pid) : {};
          const website = details.website || '';
          let er = { emails: [], phones: [], reached: 0 };
          if (website) {
            campaign.currentWebsite = website;
            saveMapCampaign(campaign);
            er = await crawlSiteForEmail(website);
            campaign.websitesCrawled++;
          }
          campaign.placesChecked++;
          campaign.emailsFound += (er.emails || []).length;

          const baseLead = {
            placeId: pid,
            name: details.name || p.name || '',
            businessName: details.name || p.name || '',
            website,
            phone: details.phone || (er.phones || [])[0] || '',
            address: details.address || p.formatted_address || '',
            rating: details.rating ?? p.rating ?? '',
            reviews: details.reviews ?? p.user_ratings_total ?? '',
            category: campaign.industry,
            categories: p.types || [],
            industry: campaign.industry,
            location: campaign.location,
            mapsUrl: pid ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(pid)}` : '',
            source: 'google_maps',
            sourceQuery: query,
            sourceSignal: `${campaign.industry} ${campaign.location}`,
            campaignId: campaign.id,
          };

          const leadRows = (er.emails && er.emails.length ? er.emails : ['']).map(email => ({ ...baseLead, email, emails: email ? [email] : [] }));
          if (campaign.verifyWhileRunning) {
            for (let i = 0; i < leadRows.length; i++) {
              if (!leadRows[i].email) continue;
              const result = await verifyEmailAddress(leadRows[i].email);
              leadRows[i] = applyVerificationToLead(leadRows[i], result);
            }
          }
          const saved = saveDorkLeadBatch(leadRows, { source: 'google_maps', campaignId: campaign.id, industry: campaign.industry, location: campaign.location });
          campaign.newEmailsAdded += saved.leads.filter(l => l.email).length ? saved.added : 0;
          campaign.duplicatesSkipped += saved.duplicates;
          logMapCampaign(campaign, `${baseLead.name || 'Place'}: ${er.emails?.length || 0} email(s), ${saved.added} new, ${saved.duplicates} duplicate/merged.`);
        } catch (e) {
          campaign.errors++;
          logMapCampaign(campaign, `Place failed: ${campaign.currentPlace} — ${e.message}`);
        }
        saveMapCampaign(campaign);
        await new Promise(r => setTimeout(r, campaign.delayBetweenPlaces));
      }
      if (campaign.newEmailsAdded >= campaign.targetEmails || campaign.placesChecked >= campaign.maxPlaces) break;
    }
    campaign = getMapCampaign(campaignId) || campaign;
    campaign.status = campaign.stopRequested || campaign.status === 'stopping' ? 'stopped' : 'completed';
    campaign.finishedAt = new Date().toISOString();
    campaign.currentPlace = '';
    campaign.currentWebsite = '';
    saveMapCampaign(campaign);
    logMapCampaign(campaign, `Campaign ${campaign.status}. Added ${campaign.newEmailsAdded} unique email leads. Duplicates merged: ${campaign.duplicatesSkipped}.`);
  } catch (e) {
    campaign = getMapCampaign(campaignId) || campaign;
    campaign.status = 'failed';
    campaign.finishedAt = new Date().toISOString();
    campaign.errors++;
    logMapCampaign(campaign, 'Campaign failed: ' + e.message);
  } finally {
    runningMapCampaigns.delete(campaignId);
  }
}

// Unified lead routes
app.get('/lead-schema', (req, res) => {
  res.json({ success: true, shortcodes: Object.keys(SHORTCODE_FIELDS), fields: SHORTCODE_FIELDS, examples: ['{name}', '{industry}', '{location}', '{rating}', '{reviews}', '{website}', '{email}'] });
});

app.get('/leads', (req, res) => {
  let leads = readJsonFile(DORK_LEADS_FILE, []).map(enrichLeadComputedFields);
  const source = String(req.query.source || '').toLowerCase();
  const ready = String(req.query.ready || '').toLowerCase();
  const q = String(req.query.q || '').toLowerCase();
  if (source) leads = leads.filter(l => String(l.source || '').toLowerCase().includes(source));
  if (ready === 'true' || ready === '1') leads = leads.filter(l => l.readyToContact || l.messageStatus === 'ready');
  if (q) leads = leads.filter(l => JSON.stringify(l).toLowerCase().includes(q));
  leads = leads.sort((a,b) => String(b.lastSeenAt || b.updatedAt || b.addedAt || '').localeCompare(String(a.lastSeenAt || a.updatedAt || a.addedAt || '')));
  const limit = Math.max(1, Math.min(50000, parseInt(req.query.limit || leads.length || 1000, 10)));
  const out = leads.slice(0, limit);
  if (req.query.format === 'csv') {
    const headers = ['name','email','phone','website','industry','location','address','rating','reviews','source','verificationStatus','leadScore','messageStatus','messageTemplateId','messageSubject','messageBody','sourceQuery','sourceSignal','addedAt','lastSeenAt'];
    const lines = [headers.map(csvEscape).join(',')];
    out.forEach(l => lines.push(headers.map(h => csvEscape(Array.isArray(l[h]) ? l[h].join('; ') : l[h])).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="unified-leads.csv"');
    return res.send('\ufeff' + lines.join('\r\n'));
  }
  res.json({ success: true, total: leads.length, returned: out.length, leads: out, serverTime: new Date().toISOString() });
});

app.get('/leads/summary', (req, res) => {
  const leads = readJsonFile(DORK_LEADS_FILE, []).map(enrichLeadComputedFields);
  const bySource = {};
  const byVerification = {};
  leads.forEach(l => {
    const s = l.source || 'unknown'; bySource[s] = (bySource[s] || 0) + 1;
    const v = l.readyToContact ? 'ready' : (l.verificationStatus || 'needs_verification'); byVerification[v] = (byVerification[v] || 0) + 1;
  });
  res.json({ success: true, total: leads.length, withEmail: leads.filter(l => l.email).length, readyMessages: leads.filter(l => l.messageStatus === 'ready').length, readyToContact: leads.filter(l => l.readyToContact).length, bySource, byVerification });
});

app.post('/leads/upsert', (req, res) => {
  const incoming = Array.isArray(req.body?.leads) ? req.body.leads : (req.body?.lead ? [req.body.lead] : []);
  if (!incoming.length) return res.status(400).json({ error: 'lead or leads array required' });
  const result = saveDorkLeadBatch(incoming, { source: 'api_upsert' });
  res.json({ success: true, ...result });
});

app.post('/leads/import-uploaded', (req, res) => {
  const defaults = { industry: req.body?.industry || '', location: req.body?.location || '' };
  let incoming = [];
  if (Array.isArray(req.body?.leads)) incoming = req.body.leads.map(l => ({ ...l, source: l.source || 'uploaded', importedAt: new Date().toISOString(), industry: l.industry || defaults.industry, location: l.location || defaults.location }));
  else if (Array.isArray(req.body?.emails)) incoming = req.body.emails.map(email => ({ email, emails: [email], source: 'uploaded', importedAt: new Date().toISOString(), ...defaults }));
  else incoming = parseUploadedEmailsText(req.body?.text || req.body?.csv || '', defaults);
  if (!incoming.length) return res.status(400).json({ error: 'No valid emails found. Send text/csv, emails[], or leads[].' });
  const result = saveDorkLeadBatch(incoming, { source: 'uploaded', industry: defaults.industry, location: defaults.location });
  res.json({ success: true, imported: incoming.length, ...result });
});


// ── BROWSER GOOGLE MAPS IMPORT (NO GOOGLE API KEY REQUIRED) ─────────────────
// This endpoint accepts rows collected by the Chrome extension from a live Google Maps page.
// It preserves the old no-API workflow: Maps page → extension extracts business name/rating/reviews/website → backend crawls website for email → unified leads.

function parseCsvRows(text) {
  const raw = String(text || '').replace(/^\ufeff/, '');
  if (!raw.trim()) return [];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i], next = raw[i + 1];
    if (q) {
      if (ch === '"' && next === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (ch === '\r') {}
      else cell += ch;
    }
  }
  row.push(cell); rows.push(row);
  const header = rows.shift() || [];
  const keys = header.map(h => String(h || '').trim());
  return rows.filter(r => r.some(c => String(c || '').trim())).map(r => {
    const o = {};
    keys.forEach((k, i) => { o[k] = r[i] || ''; });
    return o;
  });
}

function splitEmailsAny(v) {
  const vals = Array.isArray(v) ? v : String(v || '').split(/[;,\s]+/);
  return cleanEmails(new Set(vals.filter(Boolean)));
}

function firstNonEmpty(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null && String(obj[k]).trim()) return String(obj[k]).trim();
  }
  return '';
}

function normalizeBrowserMapRow(row = {}, defaults = {}) {
  const name = firstNonEmpty(row, ['name','Name','Business','business','businessName','Business Name','company','Company']);
  const website = normalizeUrl(firstNonEmpty(row, ['website','Website','url','URL','Business Website']));
  const mapsUrl = firstNonEmpty(row, ['mapsUrl','maps_url','googleMapsUrl','Google Maps URL','Profile link','Profile Link','profile','Profile','url']);
  const placeId = firstNonEmpty(row, ['placeId','place_id','Place ID','Google Place ID']);
  const address = firstNonEmpty(row, ['address','Address','formattedAddress','Formatted Address']);
  const phone = firstNonEmpty(row, ['phone','Phone','Phone Number','telephone']);
  const rating = firstNonEmpty(row, ['rating','Rating']);
  const reviews = firstNonEmpty(row, ['reviews','Reviews','reviewCount','Review Count','count','Count']);
  const email = firstNonEmpty(row, ['email','Email','emails','Emails']);
  const emails = splitEmailsAny(email);
  const lead = {
    name,
    businessName: name,
    companyName: name,
    email: emails[0] || '',
    emails,
    website,
    placeId,
    address,
    phone,
    rating,
    reviews,
    mapsUrl,
    industry: row.industry || row.Industry || defaults.industry || '',
    location: row.location || row.Location || row.city || row.City || defaults.location || '',
    category: row.category || row.Category || row.industry || row.Industry || defaults.industry || '',
    source: 'google_maps_browser',
    sourceEngine: 'browser_extension',
    sourceUrl: mapsUrl || website,
    sourceQuery: defaults.sourceQuery || `${defaults.industry || ''} ${defaults.location || ''}`.trim(),
    sourceSignal: 'google_maps_browser',
    importedAt: new Date().toISOString(),
  };
  return lead;
}

app.post('/leads/import-google-maps-browser', async (req, res) => {
  const defaults = { industry: req.body?.industry || '', location: req.body?.location || '', sourceQuery: req.body?.sourceQuery || '' };
  let rows = [];
  if (Array.isArray(req.body?.rows)) rows = req.body.rows;
  else if (Array.isArray(req.body?.businesses)) rows = req.body.businesses;
  else if (Array.isArray(req.body?.leads)) rows = req.body.leads;
  else if (req.body?.csv || req.body?.text) rows = parseCsvRows(req.body.csv || req.body.text);

  if (!rows.length) return res.status(400).json({ error: 'No Google Maps browser rows found. Send rows[], businesses[], leads[], or csv/text.' });

  const limit = Math.max(1, Math.min(1000, parseInt(req.body?.limit || rows.length, 10) || rows.length));
  const crawlWebsites = req.body?.crawlWebsites !== false;
  const inputRows = rows.slice(0, limit);
  const incoming = [];
  let websitesCrawled = 0, emailsFound = 0, rowsWithWebsite = 0, rowsWithEmail = 0;

  for (const raw of inputRows) {
    const lead = normalizeBrowserMapRow(raw, defaults);
    if (lead.website) rowsWithWebsite++;
    if (lead.email || (lead.emails && lead.emails.length)) rowsWithEmail++;

    if (crawlWebsites && lead.website && !(lead.emails && lead.emails.length)) {
      const er = await crawlSiteForEmail(lead.website);
      websitesCrawled++;
      if (er.emails && er.emails.length) {
        lead.email = er.emails[0];
        lead.emails = er.emails;
        emailsFound += er.emails.length;
      }
      if (!lead.phone && er.phones && er.phones.length) lead.phone = er.phones[0];
      lead.websitePagesReached = er.reached || 0;
      lead.lastEnrichedAt = new Date().toISOString();
    } else if (lead.emails && lead.emails.length) {
      emailsFound += lead.emails.length;
    }

    // Save even if email not found yet; later dorking/email crawl can merge into the same business by website/place/name+location.
    incoming.push(lead);
  }

  const result = saveDorkLeadBatch(incoming, { source: 'google_maps_browser', industry: defaults.industry, location: defaults.location, sourceEngine: 'browser_extension' });
  res.json({
    success: true,
    mode: 'browser_google_maps_no_api_key',
    importedBusinesses: inputRows.length,
    rowsWithWebsite,
    rowsWithEmail,
    crawlWebsites,
    websitesCrawled,
    emailsFound,
    ...result,
  });
});

// Message template routes
app.get('/message-templates', (req, res) => res.json({ success: true, templates: ensureDefaultTemplates() }));

app.post('/message-templates', (req, res) => {
  const current = ensureDefaultTemplates();
  const incoming = Array.isArray(req.body?.templates) ? req.body.templates : (req.body?.template ? [req.body.template] : []);
  if (!incoming.length) return res.status(400).json({ error: 'template or templates[] required' });
  const byId = new Map(current.map(t => [t.id, t]));
  incoming.forEach(t => {
    const id = t.id || 'tpl_' + Math.random().toString(36).slice(2, 8);
    byId.set(id, { ...t, id, priority: Number(t.priority || 50) });
  });
  const templates = Array.from(byId.values());
  writeJsonFile(MESSAGE_TEMPLATES_FILE, templates);
  res.json({ success: true, templates });
});

app.post('/message-templates/reset-defaults', (req, res) => {
  writeJsonFile(MESSAGE_TEMPLATES_FILE, DEFAULT_MESSAGE_TEMPLATES);
  res.json({ success: true, templates: DEFAULT_MESSAGE_TEMPLATES });
});

app.post('/messages/preview', (req, res) => {
  const lead = enrichLeadComputedFields(req.body?.lead || {});
  const template = req.body?.template || ensureDefaultTemplates().find(t => t.id === req.body?.templateId) || ensureDefaultTemplates()[0];
  const subject = renderTemplateText(template.subject, lead);
  const body = renderTemplateText(template.body, lead);
  const missingCodes = Array.from(new Set([...subject.missing, ...body.missing]));
  res.json({ success: true, ready: missingCodes.length === 0 && !!lead.email, missingCodes, subject: subject.rendered, body: body.rendered, template });
});

app.post('/leads/prepare-messages', (req, res) => {
  const templates = Array.isArray(req.body?.templates) && req.body.templates.length ? req.body.templates : ensureDefaultTemplates();
  const limit = Math.max(1, Math.min(50000, parseInt(req.body?.limit || 5000, 10)));
  const onlyReadyEmails = req.body?.onlyReadyEmails !== false;
  const leads = readJsonFile(DORK_LEADS_FILE, []);
  let prepared = 0, blocked = 0;
  for (let i = 0; i < leads.length && prepared + blocked < limit; i++) {
    const lead = enrichLeadComputedFields(leads[i]);
    if (onlyReadyEmails && lead.email && lead.verificationStatus === 'invalid') continue;
    const message = buildMessageForLead(lead, templates);
    leads[i] = {
      ...lead,
      messageStatus: message.status,
      messageTemplateId: message.templateId || '',
      messageSubject: message.subject || '',
      messageBody: message.body || '',
      messageMissingCodes: message.missingCodes || [],
      messageReason: message.reason || '',
      leadScore: scoreLead(lead),
      readyToContact: !!(lead.readyToContact || (message.ready && lead.email && !['invalid'].includes(lead.verificationStatus))),
      preparedAt: new Date().toISOString(),
    };
    if (message.ready) prepared++; else blocked++;
  }
  writeJsonFile(DORK_LEADS_FILE, leads);
  res.json({ success: true, prepared, blocked, total: leads.length });
});

app.get('/ready-messages', (req, res) => {
  const leads = readJsonFile(DORK_LEADS_FILE, []).map(enrichLeadComputedFields).filter(l => l.email && l.messageStatus === 'ready' && l.messageBody && l.messageSubject);
  if (req.query.format === 'csv') {
    const headers = ['email','subject','message','name','industry','location','website','phone','rating','reviews','source','verificationStatus','leadScore'];
    const lines = [headers.map(csvEscape).join(',')];
    leads.forEach(l => lines.push([
      l.email, l.messageSubject, l.messageBody, l.name || l.businessName, l.industry, l.location, l.website, l.phone, l.rating, l.reviews, l.source, l.verificationStatus, l.leadScore
    ].map(csvEscape).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ready-airtable-messages.csv"');
    return res.send('\ufeff' + lines.join('\r\n'));
  }
  res.json({ success: true, total: leads.length, leads });
});



// ── EMAIL SCOUT VERIFY → READY QUEUE ────────────────────────────────────────
// This prepares leads for the Email Scout tab. It does NOT send emails by itself.
// Sending still requires a separate sender integration or a manual review/send step.
function emailScoutLeadCanBePrepared(lead, opts = {}) {
  if (!lead || !lead.email) return { ok: false, reason: 'missing_email' };
  const status = String(lead.verificationStatus || '').toLowerCase();
  const allowRisky = !!opts.allowRisky;
  const allowNeedsProvider = !!opts.allowNeedsProvider;
  if (lead.isDisposable || status === 'invalid') return { ok: false, reason: 'invalid_or_disposable' };
  if (lead.readyToContact || status === 'valid' || status === 'deliverable') return { ok: true, reason: 'verified_ready' };
  if (allowRisky && ['catch_all','risky','unknown'].includes(status)) return { ok: true, reason: 'allowed_risky' };
  if (allowNeedsProvider && ['needs_provider','needs_verification',''].includes(status)) return { ok: true, reason: 'allowed_basic_verification' };
  return { ok: false, reason: status ? `not_ready_${status}` : 'not_verified' };
}

function emailScoutRow(lead) {
  return {
    id: lead.id || '',
    email: lead.email || '',
    subject: lead.messageSubject || '',
    message: lead.messageBody || '',
    name: lead.name || lead.businessName || '',
    businessName: lead.businessName || lead.name || '',
    industry: lead.industry || lead.category || '',
    location: lead.location || '',
    website: lead.website || '',
    phone: lead.phone || '',
    rating: lead.rating || '',
    reviews: lead.reviews || '',
    source: lead.source || '',
    sourceUrl: lead.sourceUrl || lead.mapsUrl || lead.website || '',
    verificationStatus: lead.verificationStatus || '',
    verificationScore: lead.verificationScore ?? '',
    leadScore: lead.leadScore ?? '',
    messageTemplateId: lead.messageTemplateId || '',
    messageTemplateName: lead.messageTemplateName || '',
    contactStatus: lead.contactStatus || 'ready',
    readyAt: lead.readyAt || lead.preparedAt || '',
  };
}

function getEmailScoutReadyLeads(options = {}) {
  const includeSent = !!options.includeSent;
  return readJsonFile(DORK_LEADS_FILE, [])
    .map(enrichLeadComputedFields)
    .filter(l => {
      if (!l.email || !l.emailScoutReady || l.messageStatus !== 'ready' || !l.messageSubject || !l.messageBody) return false;
      if (!includeSent && String(l.contactStatus || '').toLowerCase() === 'sent') return false;
      return true;
    })
    .sort((a,b) => String(b.readyAt || b.preparedAt || b.lastSeenAt || '').localeCompare(String(a.readyAt || a.preparedAt || a.lastSeenAt || '')));
}

app.get('/email-scout/summary', (req, res) => {
  const leads = readJsonFile(DORK_LEADS_FILE, []).map(enrichLeadComputedFields);
  const ready = leads.filter(l => l.emailScoutReady && l.messageStatus === 'ready' && l.messageBody && String(l.contactStatus || '').toLowerCase() !== 'sent').length;
  const readyIncludingSent = leads.filter(l => l.emailScoutReady && l.messageStatus === 'ready' && l.messageBody).length;
  const verified = leads.filter(l => l.readyToContact || l.verificationStatus === 'valid').length;
  const needsVerification = leads.filter(l => l.email && !l.verificationStatus && !l.readyToContact).length;
  const invalid = leads.filter(l => l.verificationStatus === 'invalid' || l.isDisposable).length;
  const blockedMissingCodes = leads.filter(l => l.messageStatus === 'blocked_missing_shortcodes').length;
  const sent = leads.filter(l => l.contactStatus === 'sent').length;
  res.json({ success: true, total: leads.length, withEmail: leads.filter(l => l.email).length, verified, needsVerification, invalid, ready, readyIncludingSent, blockedMissingCodes, sent });
});

app.post('/email-scout/verify-and-prepare', async (req, res) => {
  const provider = req.body?.provider;
  const limit = Math.max(1, Math.min(50000, parseInt(req.body?.limit || 1000, 10) || 1000));
  const verifyLimit = Math.max(1, Math.min(limit, parseInt(req.body?.verifyLimit || limit, 10) || limit));
  const onlyUnverified = req.body?.onlyUnverified !== false;
  const allowRisky = !!req.body?.allowRisky;
  const allowNeedsProvider = !!req.body?.allowNeedsProvider;
  const minLeadScore = Math.max(0, Math.min(100, parseInt(req.body?.minLeadScore || 50, 10) || 50));
  const templates = Array.isArray(req.body?.templates) && req.body.templates.length ? req.body.templates : ensureDefaultTemplates();
  const leads = readJsonFile(DORK_LEADS_FILE, []);
  let checked = 0, verified = 0, prepared = 0, blocked = 0, skipped = 0;
  const now = new Date().toISOString();

  for (let i = 0; i < leads.length && (checked + prepared + blocked + skipped) < limit; i++) {
    let lead = enrichLeadComputedFields(leads[i]);
    if (!lead.email) { skipped++; continue; }

    if ((!onlyUnverified || !lead.verificationStatus) && checked < verifyLimit) {
      try {
        const result = await verifyEmailAddress(lead.email, provider);
        lead = applyVerificationToLead(lead, result);
        checked++;
        if (result.status === 'valid' || result.readyToContact) verified++;
      } catch (e) {
        lead.verificationStatus = lead.verificationStatus || 'unknown';
        lead.verificationReason = lead.verificationReason || (e.message || String(e));
      }
    }

    const gate = emailScoutLeadCanBePrepared(lead, { allowRisky, allowNeedsProvider });
    if (!gate.ok) {
      lead.emailScoutReady = false;
      lead.emailScoutStatus = 'blocked_' + gate.reason;
      lead.emailScoutReason = gate.reason;
      leads[i] = { ...leads[i], ...lead, updatedAt: now };
      blocked++;
      continue;
    }

    const message = buildMessageForLead(lead, templates);
    const computedScore = scoreLead(lead);
    if (computedScore < minLeadScore) {
      lead.emailScoutReady = false;
      lead.emailScoutStatus = 'blocked_low_score';
      lead.emailScoutReason = `Lead score ${computedScore} is below minimum ${minLeadScore}.`;
      lead.leadScore = computedScore;
      leads[i] = { ...leads[i], ...lead, updatedAt: now };
      blocked++;
      continue;
    }

    lead = {
      ...lead,
      messageStatus: message.status,
      messageTemplateId: message.templateId || '',
      messageTemplateName: message.templateName || '',
      messageSubject: message.subject || '',
      messageBody: message.body || '',
      messageMissingCodes: message.missingCodes || [],
      messageReason: message.reason || '',
      leadScore: computedScore,
      readyToContact: !!(lead.readyToContact || message.ready),
      emailScoutReady: !!message.ready,
      emailScoutStatus: message.ready ? 'ready' : message.status,
      emailScoutReason: message.ready ? 'Prepared for Email Scout ready queue.' : (message.reason || message.status),
      contactStatus: lead.contactStatus || (message.ready ? 'ready' : ''),
      readyAt: message.ready ? (lead.readyAt || now) : lead.readyAt,
      preparedAt: now,
      updatedAt: now,
    };
    leads[i] = { ...leads[i], ...lead };
    if (message.ready) prepared++; else blocked++;
  }

  writeJsonFile(DORK_LEADS_FILE, leads);
  const ready = getEmailScoutReadyLeads();
  res.json({ success: true, checked, verified, prepared, blocked, skipped, ready: ready.length, total: leads.length, note: 'Prepared leads are added to Email Scout ready queue only. This endpoint does not send emails.' });
});

app.get('/email-scout/ready', (req, res) => {
  const leads = getEmailScoutReadyLeads();
  const limit = Math.max(1, Math.min(50000, parseInt(req.query.limit || leads.length || 1000, 10) || 1000));
  const out = leads.slice(0, limit).map(emailScoutRow);
  if (req.query.format === 'csv') {
    const headers = ['email','subject','message','name','businessName','industry','location','website','phone','rating','reviews','source','sourceUrl','verificationStatus','verificationScore','leadScore','messageTemplateId','messageTemplateName','contactStatus','readyAt'];
    const lines = [headers.map(csvEscape).join(',')];
    out.forEach(row => lines.push(headers.map(h => csvEscape(row[h])).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="email-scout-ready.csv"');
    return res.send('\ufeff' + lines.join('\r\n'));
  }
  res.json({ success: true, total: leads.length, returned: out.length, leads: out, note: 'Ready queue only. No automatic email sending is performed by this endpoint.' });
});

app.get('/email-scout/export-ready', (req, res) => {
  const leads = getEmailScoutReadyLeads();
  const rows = leads.map(emailScoutRow);
  const headers = ['email','subject','message','name','businessName','industry','location','website','phone','rating','reviews','source','sourceUrl','verificationStatus','verificationScore','leadScore','messageTemplateId','messageTemplateName','contactStatus','readyAt'];
  const lines = [headers.map(csvEscape).join(',')];
  rows.forEach(row => lines.push(headers.map(h => csvEscape(row[h])).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="email-scout-ready.csv"');
  return res.send('\ufeff' + lines.join('\r\n'));
});

app.post('/email-scout/mark-sent', (req, res) => {
  const emails = new Set((Array.isArray(req.body?.emails) ? req.body.emails : []).map(normalizeEmail).filter(Boolean));
  const ids = new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String));
  if (!emails.size && !ids.size) return res.status(400).json({ error: 'emails[] or ids[] required' });
  const leads = readJsonFile(DORK_LEADS_FILE, []);
  let updated = 0;
  const now = new Date().toISOString();
  for (let i = 0; i < leads.length; i++) {
    const email = normalizeEmail(leads[i].email || (Array.isArray(leads[i].emails) ? leads[i].emails[0] : ''));
    if ((email && emails.has(email)) || ids.has(String(leads[i].id || ''))) {
      leads[i] = { ...leads[i], contactStatus: 'sent', sentAt: now, updatedAt: now };
      updated++;
    }
  }
  writeJsonFile(DORK_LEADS_FILE, leads);
  res.json({ success: true, updated, note: 'Marked as sent. This does not send emails.' });
});


// ── EMAIL SCOUT GMAIL BATCH SENDER ──────────────────────────────────────────
// Sends prepared Email Scout ready messages through a user-connected Gmail OAuth token.
// This uses the Gmail API, not browser clicking. The user must connect Gmail and choose
// a batch limit before sending.
function base64UrlEncode(input) {
  return Buffer.from(String(input), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function mimeHeader(value) {
  const v = String(value || '');
  if (/^[\x00-\x7F]*$/.test(v)) return v.replace(/[\r\n]+/g, ' ');
  return '=?UTF-8?B?' + Buffer.from(v, 'utf8').toString('base64') + '?=';
}

function buildGmailRawMessage({ to, from, subject, body }) {
  const lines = [
    from ? `From: ${from}` : '',
    `To: ${to}`,
    `Subject: ${mimeHeader(subject || '')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    String(body || '')
  ].filter((line, idx) => idx > 6 || line !== '');
  return base64UrlEncode(lines.join('\r\n'));
}

async function refreshGmailAccessTokenForSend({ refresh_token, client_id }) {
  if (!refresh_token || !client_id) throw new Error('refresh_token and client_id are required when access_token is missing or expired.');
  const client_secret = process.env.GOOGLE_CLIENT_SECRET || '';
  if (!client_secret) throw new Error('GOOGLE_CLIENT_SECRET not set on server. Add it to Render environment variables.');
  const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
    refresh_token,
    client_id,
    client_secret,
    grant_type: 'refresh_token',
  }, { headers: { 'Content-Type': 'application/json' } });
  return tokenRes.data.access_token;
}

async function getGmailProfile(accessToken) {
  try {
    const r = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    return r.data || {};
  } catch (e) {
    return {};
  }
}

async function sendGmailApiMessage(accessToken, row, fromEmail) {
  const raw = buildGmailRawMessage({
    to: row.email,
    from: fromEmail || '',
    subject: row.messageSubject || row.subject || '',
    body: row.messageBody || row.message || ''
  });
  const r = await axios.post('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { raw }, {
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }
  });
  return r.data || {};
}

function normalizeSendBatchLimit(v) {
  const n = parseInt(v || 50, 10);
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(500, n));
}


function gmailApiErrorDetails(e) {
  const status = e && e.response ? e.response.status : 0;
  const data = (e && e.response && e.response.data) || {};
  const gErr = data.error || {};
  const reason = Array.isArray(gErr.errors) && gErr.errors[0] ? (gErr.errors[0].reason || '') : '';
  const message = gErr.message || data.error_description || data.error || (e && e.message) || String(e || 'Unknown Gmail error');
  return { status, reason, message, raw: data };
}

function isRefreshableGmailError(e) {
  const d = gmailApiErrorDetails(e);
  const text = `${d.reason} ${d.message}`.toLowerCase();
  return d.status === 401 || text.includes('invalid credentials') || text.includes('invalid token') || text.includes('auth');
}

function isInsufficientScopeError(e) {
  const d = gmailApiErrorDetails(e);
  const text = `${d.reason} ${d.message}`.toLowerCase();
  return d.status === 403 && (text.includes('insufficient') || text.includes('scope') || text.includes('permission'));
}

async function refreshGmailAccessTokenSafe(refreshToken, clientId) {
  if (!refreshToken) throw new Error('Missing refresh_token. Disconnect and reconnect Gmail with prompt=consent.');
  if (!clientId) throw new Error('Missing OAuth client_id. Save Google OAuth Client ID in Scout settings.');
  return await refreshGmailAccessTokenForSend({ refresh_token: refreshToken, client_id: clientId });
}

async function getGmailProfileWithRetry(accessToken, refreshToken, clientId) {
  try {
    const p = await getGmailProfile(accessToken);
    if (p && p.emailAddress) return { profile: p, accessToken, refreshed: false };
  } catch (_) {}
  if (refreshToken) {
    const fresh = await refreshGmailAccessTokenSafe(refreshToken, clientId);
    const p2 = await getGmailProfile(fresh);
    return { profile: p2 || {}, accessToken: fresh, refreshed: true };
  }
  return { profile: {}, accessToken, refreshed: false };
}

async function sendGmailApiMessageWithRetry({ accessToken, refreshToken, clientId, row, fromEmail }) {
  try {
    const data = await sendGmailApiMessage(accessToken, row, fromEmail);
    return { data, accessToken, refreshed: false };
  } catch (e) {
    if (isInsufficientScopeError(e)) {
      const d = gmailApiErrorDetails(e);
      throw new Error(`${d.message}. Reconnect Gmail with gmail.send permission in Scout settings.`);
    }
    if (refreshToken && isRefreshableGmailError(e)) {
      const fresh = await refreshGmailAccessTokenSafe(refreshToken, clientId);
      const data = await sendGmailApiMessage(fresh, row, fromEmail);
      return { data, accessToken: fresh, refreshed: true };
    }
    const d = gmailApiErrorDetails(e);
    throw new Error(d.message);
  }
}

function validateSendRow(row) {
  const email = normalizeEmail(row.email || row.best_email || '');
  const subject = String(row.subject || row.messageSubject || '').trim();
  const message = String(row.message || row.body || row.messageBody || '').trim();
  if (!email) return 'missing email';
  if (!isLikelyEmail(email)) return 'invalid email format';
  if (!subject) return 'missing subject';
  if (!message) return 'missing message body';
  return '';
}

function markLeadSendResult(leads, leadId, email, patch) {
  const norm = normalizeEmail(email);
  let updated = 0;
  for (let i = 0; i < leads.length; i++) {
    const lEmail = normalizeEmail(leads[i].email || (Array.isArray(leads[i].emails) ? leads[i].emails[0] : ''));
    if ((leadId && String(leads[i].id || '') === String(leadId)) || (norm && lEmail === norm)) {
      leads[i] = { ...leads[i], ...patch, updatedAt: new Date().toISOString() };
      updated++;
      break;
    }
  }
  return updated;
}

app.post('/email-scout/send-batch', async (req, res) => {
  const body = req.body || {};
  const limit = normalizeSendBatchLimit(body.limit || body.sendLimit);
  const delayMs = Math.max(0, Math.min(60000, parseInt(body.delayMs || 1500, 10) || 1500));
  const dryRun = !!body.dryRun;
  const senderEmailInput = String(body.senderEmail || body.fromEmail || '').trim();
  const batchId = 'gmail_batch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  let accessToken = body.access_token || body.accessToken || '';
  const refreshToken = body.refresh_token || body.refreshToken || '';
  const clientId = body.client_id || body.clientId || process.env.GOOGLE_CLIENT_ID || '';

  if (!accessToken && !refreshToken) {
    return res.status(400).json({
      success: false,
      error: 'Missing Gmail OAuth token.',
      required: 'Send access_token or refresh_token + client_id from the connected Gmail account.',
    });
  }

  try {
    if (!accessToken && refreshToken) {
      accessToken = await refreshGmailAccessTokenForSend({ refresh_token: refreshToken, client_id: clientId });
    }
    const profile = accessToken ? await getGmailProfile(accessToken) : {};
    const actualSenderEmail = profile.emailAddress || senderEmailInput || 'connected-gmail-account';
    const ready = getEmailScoutReadyLeads({ includeSent: false }).slice(0, limit);
    if (!ready.length) return res.json({ success: true, batchId, senderEmail: actualSenderEmail, requested: limit, sent: 0, failed: 0, skipped: 0, results: [], note: 'No unsent ready emails in queue.' });

    const leads = readJsonFile(DORK_LEADS_FILE, []);
    const results = [];
    let sent = 0, failed = 0, skipped = 0;
    const now = new Date().toISOString();

    for (let i = 0; i < ready.length; i++) {
      const lead = ready[i];
      const row = emailScoutRow(lead);
      const invalidReason = validateSendRow({ email: row.email, subject: row.subject, message: row.message });
      if (invalidReason) {
        skipped++;
        results.push({ id: row.id, email: row.email, status: 'skipped', reason: invalidReason });
        continue;
      }
      if (dryRun) {
        skipped++;
        results.push({ id: row.id, email: row.email, status: 'dry_run', subject: row.subject });
        continue;
      }
      try {
        const gmailResult = await sendGmailApiMessage(accessToken, lead, actualSenderEmail);
        const patch = {
          contactStatus: 'sent',
          sentAt: new Date().toISOString(),
          sentBy: actualSenderEmail,
          sendBatchId: batchId,
          sendProvider: 'gmail_api',
          gmailMessageId: gmailResult.id || '',
          gmailThreadId: gmailResult.threadId || '',
          lastSendError: '',
        };
        markLeadSendResult(leads, row.id, row.email, patch);
        sent++;
        results.push({ id: row.id, email: row.email, status: 'sent', gmailMessageId: gmailResult.id || '', gmailThreadId: gmailResult.threadId || '' });
      } catch (e) {
        failed++;
        const errData = e.response?.data || {};
        const reason = errData.error?.message || errData.error_description || e.message || String(e);
        markLeadSendResult(leads, row.id, row.email, {
          contactStatus: 'send_failed',
          sendFailedAt: new Date().toISOString(),
          sentBy: actualSenderEmail,
          sendBatchId: batchId,
          sendProvider: 'gmail_api',
          lastSendError: reason,
        });
        results.push({ id: row.id, email: row.email, status: 'failed', reason });
      }
      if (delayMs && i < ready.length - 1) await sleep(delayMs);
    }

    if (!dryRun) writeJsonFile(DORK_LEADS_FILE, leads);
    res.json({
      success: true,
      batchId,
      senderEmail: actualSenderEmail,
      requested: limit,
      attempted: ready.length,
      sent,
      failed,
      skipped,
      dryRun,
      startedAt: now,
      finishedAt: new Date().toISOString(),
      results,
      note: dryRun ? 'Dry run only. No email was sent.' : 'Messages were sent through the connected Gmail account via Gmail API.'
    });
  } catch (e) {
    const errData = e.response?.data || {};
    res.status(400).json({ success: false, error: errData.error?.message || errData.error_description || e.message || String(e) });
  }
});

app.post('/email-scout/send-automatic', (req, res) => {
  res.status(400).json({
    success: false,
    error: 'Use /email-scout/send-batch instead.',
    reason: 'Browser-click Gmail sending is not used. Scout sends through the connected Gmail OAuth account via Gmail API, with an explicit user-selected batch limit.',
    allowedNextStep: 'POST /email-scout/send-batch with limit, senderEmail, and Gmail OAuth tokens.'
  });
});



// Send an explicit selected batch from the Scout App local queue through Gmail API.
// This is used when Scout App stores leads in IndexedDB/local browser storage and the backend
// should send exactly the contacts the user selected, not whatever happens to be in server files.
app.post('/email-scout/send-selected-batch', async (req, res) => {
  const body = req.body || {};
  const rawContacts = Array.isArray(body.contacts) ? body.contacts : [];
  const limit = normalizeSendBatchLimit(body.limit || rawContacts.length || 50);
  const delayMs = Math.max(0, Math.min(60000, parseInt(body.delayMs || 1500, 10) || 0));
  const dryRun = !!body.dryRun;
  const senderEmailInput = String(body.senderEmail || body.fromEmail || '').trim();
  const batchId = 'gmail_selected_batch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  let accessToken = body.access_token || body.accessToken || '';
  const refreshToken = body.refresh_token || body.refreshToken || '';
  const clientId = body.client_id || body.clientId || process.env.GOOGLE_CLIENT_ID || '';
  const expiresAt = Number(body.expires_at || body.expiresAt || 0);
  const nowMs = Date.now();

  if (!rawContacts.length) {
    return res.status(400).json({ success: false, error: 'No contacts supplied. Send contacts: [{ email, subject, message }].' });
  }
  if (!accessToken && !refreshToken) {
    return res.status(400).json({ success: false, error: 'Missing Gmail OAuth token. Connect Gmail in Scout App Settings first.' });
  }

  try {
    let tokenRefreshed = false;
    if (refreshToken && (!accessToken || (expiresAt && expiresAt < nowMs + 60000) || body.forceRefresh)) {
      accessToken = await refreshGmailAccessTokenSafe(refreshToken, clientId);
      tokenRefreshed = true;
    }

    const prof = await getGmailProfileWithRetry(accessToken, refreshToken, clientId);
    accessToken = prof.accessToken || accessToken;
    tokenRefreshed = tokenRefreshed || !!prof.refreshed;
    const profile = prof.profile || {};
    const actualSenderEmail = profile.emailAddress || senderEmailInput || 'connected-gmail-account';

    const contacts = rawContacts.slice(0, limit).map((c, i) => ({
      id: c.id || c.leadId || c.businessId || ('contact_' + i),
      name: c.name || c.businessName || c.business || c.company || '',
      email: normalizeEmail(c.email || c.best_email || ''),
      subject: String(c.subject || c.messageSubject || '').trim(),
      message: String(c.message || c.body || c.messageBody || '').trim(),
      templateName: c.templateName || c.messageTemplateName || '',
    }));

    const results = [];
    let sent = 0, failed = 0, skipped = 0;
    const startedAt = new Date().toISOString();

    for (let i = 0; i < contacts.length; i++) {
      const row = contacts[i];
      const invalidReason = validateSendRow(row);
      if (invalidReason) {
        skipped++;
        results.push({ id: row.id, email: row.email, name: row.name, status: 'skipped', reason: invalidReason, subject: row.subject });
        continue;
      }
      if (dryRun) {
        skipped++;
        results.push({ id: row.id, email: row.email, name: row.name, status: 'dry_run', subject: row.subject });
        continue;
      }
      try {
        const sendResult = await sendGmailApiMessageWithRetry({ accessToken, refreshToken, clientId, row, fromEmail: actualSenderEmail });
        accessToken = sendResult.accessToken || accessToken;
        tokenRefreshed = tokenRefreshed || !!sendResult.refreshed;
        const gmailResult = sendResult.data || {};
        sent++;
        results.push({ id: row.id, email: row.email, name: row.name, status: 'sent', subject: row.subject, gmailMessageId: gmailResult.id || '', gmailThreadId: gmailResult.threadId || '' });
      } catch (e) {
        failed++;
        const reason = (e && e.message) || String(e);
        results.push({ id: row.id, email: row.email, name: row.name, status: 'failed', subject: row.subject, reason });
      }
      if (delayMs && i < contacts.length - 1) await sleep(delayMs);
    }

    res.json({
      success: true,
      batchId,
      senderEmail: actualSenderEmail,
      requested: limit,
      attempted: contacts.length,
      sent,
      failed,
      skipped,
      dryRun,
      tokenRefreshed,
      access_token: tokenRefreshed ? accessToken : undefined,
      startedAt,
      finishedAt: new Date().toISOString(),
      results,
      note: dryRun ? 'Dry run only. No email was sent.' : 'Messages were sent through the connected Gmail account via Gmail API.'
    });
  } catch (e) {
    const details = gmailApiErrorDetails(e);
    res.status(400).json({ success: false, error: details.message, status: details.status, reason: details.reason });
  }
});

app.get('/email-scout/send-diagnostics', (req, res) => {
  res.json({
    success: true,
    version: '4.8.0',
    routes: {
      selectedBatch: true,
      sendBatch: true,
      gmailStatus: true,
    },
    env: {
      googleClientSecretSet: !!process.env.GOOGLE_CLIENT_SECRET,
      googleClientIdSet: !!process.env.GOOGLE_CLIENT_ID,
    },
    validations: {
      isLikelyEmailDefined: typeof isLikelyEmail === 'function',
      normalizeEmailDefined: typeof normalizeEmail === 'function',
    },
    serverTime: new Date().toISOString(),
  });
});

// Google Maps lead campaign routes
app.post('/maps-campaigns/start', (req, res) => {
  const campaign = normalizeMapsCampaignPayload(req.body || {});
  if (!campaign.industry || !campaign.location) return res.status(400).json({ error: 'industry and location required' });
  saveMapCampaign(campaign);
  setTimeout(() => runGoogleMapsCampaign(campaign.id), 50);
  res.json({ success: true, campaign });
});

app.get('/maps-campaigns', (req, res) => {
  const campaigns = readMapCampaigns().sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.json({ success: true, total: campaigns.length, running: Array.from(runningMapCampaigns.keys()), campaigns });
});

app.get('/maps-campaigns/:id', (req, res) => {
  const campaign = getMapCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'maps campaign not found' });
  res.json({ success: true, campaign, isRunning: runningMapCampaigns.has(req.params.id), serverTime: new Date().toISOString() });
});

app.post('/maps-campaigns/:id/stop', (req, res) => {
  const campaign = getMapCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'maps campaign not found' });
  campaign.stopRequested = true;
  campaign.status = runningMapCampaigns.has(req.params.id) ? 'stopping' : 'stopped';
  saveMapCampaign(campaign);
  res.json({ success: true, campaign });
});

app.get('/maps-campaigns/:id/leads', (req, res) => {
  let leads = readJsonFile(DORK_LEADS_FILE, []).filter(l => l.campaignId === req.params.id || (Array.isArray(l.campaignIds) && l.campaignIds.includes(req.params.id)) || l.source === 'google_maps');
  const since = String(req.query.since || req.query.updatedSince || '');
  if (since) leads = leads.filter(l => String(l.lastSeenAt || l.updatedAt || l.addedAt || '') > since);
  leads = leads.sort((a,b) => String(b.lastSeenAt || b.updatedAt || b.addedAt || '').localeCompare(String(a.lastSeenAt || a.updatedAt || a.addedAt || '')));
  res.json({ success: true, campaignId: req.params.id, total: leads.length, leads: leads.slice(0, Math.min(5000, parseInt(req.query.limit || 1000, 10))), serverTime: new Date().toISOString() });
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

    // Get the user's real Gmail address. Gmail scopes do not always allow oauth2/userinfo,
    // so use the Gmail profile endpoint first. This prevents the old unknown@gmail.com fallback.
    let email = '';
    let profileSource = '';
    if (tokens.access_token) {
      try {
        const gmailProfile = await getGmailProfile(tokens.access_token);
        if (gmailProfile && gmailProfile.emailAddress) {
          email = gmailProfile.emailAddress;
          profileSource = 'gmail_profile';
        }
      } catch {}
      if (!email) {
        try {
          const profileRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { 'Authorization': 'Bearer ' + tokens.access_token }
          });
          email = profileRes.data.email || '';
          if (email) profileSource = 'oauth_userinfo';
        } catch {}
      }
    }

    if (!email) {
      return res.status(400).json({
        error: 'Gmail connected, but Scout could not read the Gmail address. Reconnect with gmail.send / gmail.readonly scopes and make sure Gmail API is enabled.',
        code: 'gmail_email_profile_missing'
      });
    }

    res.json({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in || 3600,
      scope: tokens.scope || '',
      email,
      profile_source: profileSource,
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



function gmailDiagnosticPayload(req) {
  return {
    ok: true,
    version: 'v4.6-gmail-identity-fix',
    google_client_secret_set: Boolean(process.env.GOOGLE_CLIENT_SECRET),
    google_client_id_set: Boolean(process.env.GOOGLE_CLIENT_ID),
    gmail_client_secret_env_name: 'GOOGLE_CLIENT_SECRET',
    endpoints: {
      exchange: true,
      refresh: true,
      profile: true,
      send_selected_batch: true,
      status: true,
    },
    required_frontend_redirect_uri: req.query.redirect_uri || 'Use the exact Scout App URL shown in Settings',
    notes: [
      'If google_client_secret_set is false, add GOOGLE_CLIENT_SECRET in Render Environment and redeploy.',
      'If this endpoint returns 404, your Render backend is still running an older build or your Backend URL points to the wrong service.',
      'Google Cloud Authorized redirect URI must exactly match the Scout App redirect URI.',
      'Reconnect Gmail after changing scopes.'
    ],
  };
}

// Gmail OAuth diagnostic status. Multiple aliases are provided so the frontend can test safely.
app.get('/gmail/status', (req, res) => res.json(gmailDiagnosticPayload(req)));
app.get('/gmail/diagnostics', (req, res) => res.json(gmailDiagnosticPayload(req)));
app.get('/gmail/test', (req, res) => res.json(gmailDiagnosticPayload(req)));

// Resolve the real connected Gmail email from saved tokens.
app.post('/gmail/profile', async (req, res) => {
  const body = req.body || {};
  let accessToken = body.access_token || body.accessToken || '';
  const refreshToken = body.refresh_token || body.refreshToken || '';
  const clientId = body.client_id || body.clientId || process.env.GOOGLE_CLIENT_ID || '';
  try {
    let profile = accessToken ? await getGmailProfile(accessToken) : {};
    if ((!profile || !profile.emailAddress) && refreshToken) {
      accessToken = await refreshGmailAccessTokenForSend({ refresh_token: refreshToken, client_id: clientId });
      profile = await getGmailProfile(accessToken);
    }
    if (!profile || !profile.emailAddress) {
      return res.status(400).json({ success: false, error: 'Could not resolve Gmail profile email. Reconnect Gmail and confirm Gmail API is enabled.' });
    }
    res.json({
      success: true,
      email: profile.emailAddress,
      messagesTotal: profile.messagesTotal,
      threadsTotal: profile.threadsTotal,
      access_token: accessToken || undefined,
    });
  } catch (e) {
    const errData = e.response?.data || {};
    res.status(400).json({ success: false, error: errData.error?.message || errData.error_description || e.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Scout Backend v4.6 Gmail Identity Fix on port ${PORT} | Admin key: ${ADMIN_KEY} | Maps key: ${GMAPS_KEY?'SET':'NOT SET'}`);
});
