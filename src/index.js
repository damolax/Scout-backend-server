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

// ── IN-MEMORY STORES ──────────────────────────────────────────────────────────
let contactedPlaceIds = {};
let dailySummaries = [];

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DORK_SETTINGS_FILE = path.join(DATA_DIR, 'dork-settings.json');
const DORK_LEADS_FILE = path.join(DATA_DIR, 'dork-leads.json');
const CAMPAIGNS_FILE = path.join(DATA_DIR, 'dork-campaigns.json');

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

function leadDedupeKey(lead) {
  const email = normalizeEmail(lead.email || (Array.isArray(lead.emails) ? lead.emails[0] : ''));
  if (email) return 'email:' + email;
  const website = rootDomain(lead.website || lead.url || '');
  if (website) return 'site:' + website;
  return '';
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
    businessName: raw.businessName || raw.business_name || name,
    email,
    emails,
    website,
    domain,
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
    sourceCount: Number(raw.sourceCount || 1),
    status: raw.status || 'found',
    verificationStatus: raw.verificationStatus || raw.verification_status || 'needs_verification',
    verificationScore: raw.verificationScore || raw.verification_score || '',
    verificationProvider: raw.verificationProvider || raw.verification_provider || '',
    verificationReason: raw.verificationReason || raw.verification_reason || '',
    verifiedAt: raw.verifiedAt || raw.verified_at || '',
    readyToContact: !!(raw.readyToContact || raw.ready_to_contact),
  };
}

function mergeDorkLead(existing, incoming) {
  const now = new Date().toISOString();
  const merged = { ...existing };
  ['name','businessName','website','domain','industry','location','sourceQuery','sourceSignal','sourceUrl','sourceEngine','campaignId'].forEach(k => {
    if (!merged[k] && incoming[k]) merged[k] = incoming[k];
  });
  merged.email = existing.email || incoming.email;
  merged.emails = uniquePush(existing.emails || [], incoming.emails || incoming.email);
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
    const key = leadDedupeKey(leads[idx]);
    if (key) byKey.set(key, idx);
  });
  let added = 0, updated = 0, duplicates = 0;
  const saved = [];
  for (const raw of incoming) {
    const lead = normalizeDorkLead(raw, context);
    const key = leadDedupeKey(lead);
    if (!key) continue;
    if (byKey.has(key)) {
      const idx = byKey.get(key);
      leads[idx] = mergeDorkLead(leads[idx], lead);
      updated++;
      duplicates++;
      saved.push(leads[idx]);
    } else {
      leads.push(lead);
      byKey.set(key, leads.length - 1);
      added++;
      saved.push(lead);
    }
  }
  writeJsonFile(DORK_LEADS_FILE, leads.slice(-50000));
  return { added, updated, duplicates, total: leads.length, leads: saved };
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
function extractBingUrls(html) {
  const urls = new Set();
  const blockRegex = /<li[^>]+class="[^"]*b_algo[^"]*"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"/gi;
  let m;
  while ((m = blockRegex.exec(html))) urls.add(htmlDecode(m[1]));
  const fallback = /<a[^>]+href="(https?:\/\/[^"]+)"/gi;
  while ((m = fallback.exec(html))) urls.add(htmlDecode(m[1]));
  return Array.from(urls)
    .map(u => normalizeUrl(u))
    .filter(u => /^https?:\/\//i.test(u))
    .filter(u => !/(^https?:\/\/([^\/]+\.)?(bing|microsoft|msn)\.)/i.test(u))
    .filter(u => !/\/search\?|\/images\//i.test(u))
    .slice(0, 100);
}

async function searchBingUrls(query, limit = 30) {
  const urls = [];
  const seen = new Set();
  const safeLimit = Math.max(1, Math.min(100, parseInt(limit || 30, 10)));
  for (let first = 1; urls.length < safeLimit && first <= 91; first += 10) {
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10&first=${first}`;
    const html = await fetchPage(searchUrl, 12000);
    const found = extractBingUrls(html);
    for (const u of found) {
      const key = normalizeUrl(u).replace(/\/$/, '');
      if (!seen.has(key)) { seen.add(key); urls.push(u); }
      if (urls.length >= safeLimit) break;
    }
    if (!found.length) break;
    await new Promise(r => setTimeout(r, 600));
  }
  return urls.slice(0, safeLimit);
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
      try { urls = await searchBingUrls(query, campaign.resultsPerSignal); }
      catch(e) { campaign.errors++; logCampaign(campaign, 'Bing search failed: ' + e.message); }
      campaign.totalUrlsDiscovered += urls.length;
      saveCampaign(campaign);

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
              sourceEngine: 'bing',
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
  status: 'ok', service: 'Scout Backend v3.5 Cloud Runner', timestamp: new Date().toISOString(),
  hasGmapsKey: !!GMAPS_KEY,
  emailVerifier: {
    provider: EMAIL_VERIFIER_PROVIDER || 'basic_mx',
    hasProviderKey: !!getVerifierProviderKey(EMAIL_VERIFIER_PROVIDER),
  },
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
  console.log(`Scout Backend v3.5 Cloud Runner on port ${PORT} | Admin key: ${ADMIN_KEY} | Maps key: ${GMAPS_KEY?'SET':'NOT SET'}`);
});
