const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// ── EMAIL FILTERING ─────────────────────────────────────────────────────────

const JUNK = [
  'sentry', 'wixpress', 'example.com', '.png', '.jpg', '.jpeg', '.gif',
  '.webp', '.svg', 'godaddy', 'schema.org', 'cloudflare', 'sentry.io',
  'your-email', 'email@domain', 'name@', 'user@', 'domain.com',
  'noreply', 'no-reply', 'donotreply', 'bounce', 'mailer-daemon',
  'postmaster', 'webmaster', 'abuse@', 'spam@', 'test@', 'example@',
  'info@example', 'support@example', 'sales@example',
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

// Score emails: prefer contact/info/hello over generic patterns
function scoreEmail(email) {
  const local = email.split('@')[0];
  if (/^(contact|hello|hi|enquir|info|mail|bookings|reservations|admin)/.test(local)) return 3;
  if (/^(sales|support|help|service|office|team|studio)/.test(local)) return 2;
  if (/\d{3,}/.test(local)) return 0; // lots of numbers = likely auto-generated
  return 1;
}

function rankEmails(emails) {
  return emails.sort((a, b) => scoreEmail(b) - scoreEmail(a));
}

// ── HTTP FETCH ────────────────────────────────────────────────────────────────

async function fetchPage(url, timeout = 9000) {
  try {
    const res = await axios.get(url, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
      },
      maxRedirects: 6,
      validateStatus: s => s < 500,
    });
    return res.data || '';
  } catch {
    return '';
  }
}

// ── EMAIL EXTRACTION STRATEGIES ──────────────────────────────────────────────

function extractEmailsFromHtml(html) {
  const emails = new Set();

  // Strategy 1: mailto links (highest confidence)
  (html.match(/mailto:([^"'?<>\s,;]+)/gi) || [])
    .forEach(m => emails.add(m.replace(/mailto:/i, '')));

  // Strategy 2: plain text pattern
  (html.match(/[a-z0-9._%+\-]{1,64}@[a-z0-9.\-]+\.[a-z]{2,}/gi) || [])
    .forEach(e => emails.add(e));

  // Strategy 3: obfuscated — "user [at] domain [dot] com"
  const atDot = html.match(/([a-z0-9._%+\-]+)\s*[\[(]?\s*(?:at|@)\s*[\])]?\s*([a-z0-9.\-]+)\s*[\[(]?\s*(?:dot|\.)\s*[\])]?\s*([a-z]{2,})/gi) || [];
  atDot.forEach(m => {
    const cleaned = m.replace(/\s*[\[(]?\s*(at|@)\s*[\])]?\s*/gi, '@').replace(/\s*[\[(]?\s*(dot|\.)\s*[\])]?\s*/gi, '.').replace(/\s+/g, '');
    if (cleaned.includes('@') && cleaned.includes('.')) emails.add(cleaned.toLowerCase());
  });

  // Strategy 4: JSON-LD / schema.org structured data
  const scripts = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  scripts.forEach(s => {
    try {
      const json = JSON.parse(s.replace(/<script[^>]*>|<\/script>/gi, ''));
      const traverse = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (obj.email && typeof obj.email === 'string') emails.add(obj.email);
        Object.values(obj).forEach(v => traverse(v));
      };
      traverse(json);
    } catch {}
  });

  // Strategy 5: data attributes (e.g. data-email="...")
  (html.match(/data-email=["']([^"']+@[^"']+)["']/gi) || [])
    .forEach(m => {
      const e = m.match(/["']([^"']+@[^"']+)["']/);
      if (e) emails.add(e[1]);
    });

  return emails;
}

function extractPhonesFromHtml(html) {
  const phones = new Set();
  // tel: links (most reliable)
  (html.match(/tel:([+\d\s\-().]+)/gi) || [])
    .forEach(m => {
      const clean = m.replace(/tel:/i, '').trim();
      if (clean.replace(/\D/g, '').length >= 7) phones.add(clean);
    });
  // Plain number patterns
  (html.match(/(?:\+?[\d][\d\s\-().]{7,}[\d])/g) || [])
    .forEach(ph => {
      const digits = ph.replace(/\D/g, '');
      if (digits.length >= 7 && digits.length <= 15) phones.add(ph.trim());
    });
  return phones;
}

// ── WEBSITE CRAWL ─────────────────────────────────────────────────────────────

// Contact page patterns — ordered by likelihood
const CONTACT_PATHS = [
  '', '/contact', '/contact-us', '/contactus', '/contacts',
  '/about', '/about-us', '/aboutus', '/about/contact',
  '/get-in-touch', '/reach-us', '/reach-out',
  '/support', '/help', '/info', '/information',
  '/team', '/our-team', '/staff',
  '/connect', '/enquiry', '/enquiries', '/inquiry',
];

async function crawlSiteForEmail(websiteUrl) {
  if (!websiteUrl) return { emails: [], phones: [], reached: 0, sources: [] };

  let origin;
  try {
    const u = new URL(websiteUrl.startsWith('http') ? websiteUrl : 'https://' + websiteUrl);
    origin = u.origin;
  } catch {
    return { emails: [], phones: [], reached: 0, sources: [] };
  }

  const emails = new Set();
  const phones = new Set();
  const sources = [];
  let reached = 0;

  for (const p of CONTACT_PATHS) {
    const url = origin + p;
    const html = await fetchPage(url);
    if (!html) continue;
    reached++;

    const found = extractEmailsFromHtml(html);
    const foundPhones = extractPhonesFromHtml(html);

    if (found.size > 0) {
      sources.push({ path: p || '/', count: found.size });
    }

    found.forEach(e => emails.add(e));
    foundPhones.forEach(p => phones.add(p));

    // Stop early if we have good emails from contact pages
    const cleaned = cleanEmails(emails);
    if (cleaned.length >= 2 && p.includes('contact')) break;
    if (cleaned.length >= 3) break;
  }

  const cleaned = rankEmails(cleanEmails(emails));
  const cleanedPhones = Array.from(phones)
    .filter((p, i, a) => a.indexOf(p) === i)
    .slice(0, 3);

  return {
    emails: cleaned.slice(0, 5),
    phones: cleanedPhones,
    reached,
    sources,
  };
}

// ── PLACE ID → WEBSITE VIA GOOGLE MAPS API ──────────────────────────────────

function extractPlaceIdFromUrl(mapsUrl) {
  if (!mapsUrl) return null;
  // Format: !19sChIJ...
  const m = mapsUrl.match(/!19s(ChIJ[^!?&]+)/);
  if (m) return decodeURIComponent(m[1]);
  // Fallback: look for place_id= param
  try {
    const u = new URL(mapsUrl);
    return u.searchParams.get('place_id') || null;
  } catch {}
  return null;
}

async function getPlaceDetails(placeId) {
  if (!GMAPS_KEY) {
    return { error: 'No GOOGLE_MAPS_API_KEY set on server', website: null, phone: null, name: null };
  }
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,website,formatted_phone_number,formatted_address,rating,user_ratings_total,business_status&key=${GMAPS_KEY}`;
    const res = await axios.get(url, { timeout: 8000 });
    const r = res.data?.result;
    if (!r) return { error: 'No result from Places API', website: null, phone: null };
    return {
      name: r.name || null,
      website: r.website || null,
      phone: r.formatted_phone_number || null,
      address: r.formatted_address || null,
      rating: r.rating || null,
      reviews: r.user_ratings_total || null,
      status: r.business_status || null,
    };
  } catch (err) {
    return { error: err.message, website: null, phone: null };
  }
}

// ── INDUSTRY DETECTION ───────────────────────────────────────────────────────

const INDUSTRY_MAP = [
  { name: 'restaurant', keys: ['restaurant','cafe','coffee','diner','bistro','eatery','food','catering','bakery','pizza','sushi','bar','pub','kitchen','grill','burger','chicken','rice','noodle','jollof','suya','buka','mama put','taco','kebab','shawarma','brunch'] },
  { name: 'beauty', keys: ['salon','beauty','hair','nail','spa','barber','lash','brow','makeup','waxing','threading','tanning','aesthetic','skincare','facial','massage','cosmetic'] },
  { name: 'home_services', keys: ['plumber','plumbing','electrician','hvac','heating','cleaning','cleaner','lawn','landscaping','pest','roofing','handyman','painter','carpenter','flooring','renovation','remodel','contractor','fencing','gutters'] },
  { name: 'healthcare', keys: ['clinic','doctor','physician','dentist','dental','optometrist','physiotherapy','physio','chiropractic','therapy','therapist','medical','health','pharmacy','nurse','hospital','urgent care','dermatologist'] },
  { name: 'fitness', keys: ['gym','fitness','trainer','yoga','pilates','crossfit','bootcamp','martial arts','boxing','swimming','sports','coach','workout','studio','athletics'] },
  { name: 'real_estate', keys: ['real estate','property','realtor','estate agent','letting','rental','landlord','tenant','housing','mortgage','development','developer'] },
  { name: 'legal', keys: ['law','solicitor','attorney','lawyer','legal','barrister','notary','paralegal','conveyancing','litigation','advocate','counsel'] },
  { name: 'accounting', keys: ['accountant','accounting','bookkeeper','bookkeeping','financial advisor','tax','audit','cpa','wealth','mortgage broker','payroll'] },
  { name: 'automotive', keys: ['auto','car','vehicle','mechanic','garage','repair','detailing','tyres','tires','workshop','dealership','mot','oil change','transmission','suspension','alignment','balanceo'] },
  { name: 'education', keys: ['school','tutor','tutoring','course','training','e-learning','workshop','academy','learning','teacher','instructor','college','university','nursery','preschool'] },
  { name: 'events', keys: ['event','venue','wedding','planner','dj','entertainer','photographer','videographer','rental','entertainment','catering','party','celebration'] },
  { name: 'hospitality', keys: ['hotel','hostel','motel','bnb','bed and breakfast','guesthouse','resort','lodge','inn','travel','tour','holiday','airbnb'] },
  { name: 'retail', keys: ['shop','store','retail','boutique','ecommerce','merchandise','inventory','wholesale','brand','market','supermarket'] },
  { name: 'construction', keys: ['construction','builder','architect','civil','structural','project','site','contractor','subcontractor','build','renovate'] },
  { name: 'logistics', keys: ['courier','freight','moving','delivery','dispatch','logistics','transport','fleet','shipping','haulage','removal'] },
  { name: 'professional_services', keys: ['agency','consultant','marketing','it service','hr','virtual assistant','staffing','recruitment','pr','branding'] },
  { name: 'childcare', keys: ['daycare','nursery','preschool','childcare','nanny','kindergarten','creche','after school','kids','children'] },
  { name: 'pet', keys: ['vet','veterinary','groomer','grooming','pet','dog','cat','kennel','boarding','animal','paws'] },
  { name: 'cleaning', keys: ['cleaning','cleaner','maid','janitorial','housekeeping','domestic','laundry','dry clean','pressure wash'] },
  { name: 'security', keys: ['security','guard','cctv','alarm','surveillance','protection','patrol','locksm'] },
];

function detectIndustry(text) {
  const t = (text || '').toLowerCase();
  for (const ind of INDUSTRY_MAP) {
    if (ind.keys.some(k => t.includes(k))) return ind.name;
  }
  return 'general';
}

// ── ROUTES ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Scout Email Finder v2', timestamp: new Date().toISOString(), hasGmapsKey: !!GMAPS_KEY });
});

// Find email from a website URL
app.post('/find-email', async (req, res) => {
  const { website, business_name } = req.body;
  if (!website) return res.status(400).json({ error: 'website is required' });

  try {
    const result = await crawlSiteForEmail(website);
    res.json({
      success: true,
      business_name,
      website,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Batch: find emails for multiple businesses (by website)
app.post('/batch-find-emails', async (req, res) => {
  const { businesses } = req.body;
  if (!businesses || !Array.isArray(businesses)) {
    return res.status(400).json({ error: 'businesses array required' });
  }

  const results = [];
  for (const biz of businesses.slice(0, 50)) {
    if (!biz.website) {
      results.push({ id: biz.id, business_name: biz.business_name, emails: [], phones: [], reached: 0, error: 'no website' });
      continue;
    }
    const result = await crawlSiteForEmail(biz.website);
    results.push({ id: biz.id, business_name: biz.business_name, website: biz.website, ...result });
    await new Promise(r => setTimeout(r, 400));
  }

  res.json({ success: true, results });
});

// ── NEW: Enrich a single business via Google Maps Place ID ───────────────────
// Gets website + phone from Places API, then crawls the website for email
app.post('/enrich-place', async (req, res) => {
  const { place_id, maps_url, business_name } = req.body;

  const pid = place_id || extractPlaceIdFromUrl(maps_url);
  if (!pid) return res.status(400).json({ error: 'place_id or maps_url required' });

  try {
    // Step 1: get place details (website, phone)
    const place = await getPlaceDetails(pid);

    if (place.error && !place.website) {
      return res.json({ success: false, place_id: pid, business_name, error: place.error, website: null, emails: [], phones: [] });
    }

    // Step 2: if we got a website, crawl it for email
    let emailResult = { emails: [], phones: [], reached: 0 };
    if (place.website) {
      emailResult = await crawlSiteForEmail(place.website);
      // Merge phones from both sources
      if (place.phone && !emailResult.phones.includes(place.phone)) {
        emailResult.phones = [place.phone, ...emailResult.phones].slice(0, 3);
      }
    } else if (place.phone) {
      emailResult.phones = [place.phone];
    }

    res.json({
      success: true,
      place_id: pid,
      business_name: place.name || business_name,
      website: place.website || null,
      phone: place.phone || null,
      address: place.address || null,
      rating: place.rating || null,
      reviews: place.reviews || null,
      business_status: place.status || null,
      emails: emailResult.emails,
      phones: emailResult.phones,
      reached: emailResult.reached,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── NEW: Batch enrich via Place IDs ─────────────────────────────────────────
app.post('/batch-enrich', async (req, res) => {
  const { businesses } = req.body; // [{id, place_id?, maps_url?, business_name?}]
  if (!businesses || !Array.isArray(businesses)) {
    return res.status(400).json({ error: 'businesses array required' });
  }

  const results = [];
  for (const biz of businesses.slice(0, 30)) { // cap: Places API has cost
    const pid = biz.place_id || extractPlaceIdFromUrl(biz.maps_url);
    if (!pid) {
      results.push({ id: biz.id, business_name: biz.business_name, error: 'no place_id extractable', emails: [], website: null });
      continue;
    }

    try {
      const place = await getPlaceDetails(pid);
      let emailResult = { emails: [], phones: [] };

      if (place.website) {
        emailResult = await crawlSiteForEmail(place.website);
        if (place.phone && !emailResult.phones.includes(place.phone)) {
          emailResult.phones = [place.phone, ...(emailResult.phones || [])].slice(0, 3);
        }
      } else if (place.phone) {
        emailResult.phones = [place.phone];
      }

      results.push({
        id: biz.id,
        place_id: pid,
        business_name: place.name || biz.business_name,
        website: place.website || null,
        phone: place.phone || null,
        address: place.address || null,
        emails: emailResult.emails || [],
        phones: emailResult.phones || [],
        error: place.error || null,
      });
    } catch (err) {
      results.push({ id: biz.id, business_name: biz.business_name, error: err.message, emails: [], website: null });
    }

    await new Promise(r => setTimeout(r, 500)); // rate-limit friendly
  }

  res.json({ success: true, results });
});

// Detect industry from text signals
app.post('/detect-industry', async (req, res) => {
  const { business_name, category, description } = req.body;
  const text = [business_name, category, description].filter(Boolean).join(' ');
  res.json({ industry: detectIndustry(text) });
});

// ── NEW: Extract Place ID from Maps URL (utility endpoint) ──────────────────
app.post('/extract-place-id', (req, res) => {
  const { maps_url } = req.body;
  const place_id = extractPlaceIdFromUrl(maps_url);
  res.json({ place_id, found: !!place_id });
});

app.listen(PORT, () => {
  console.log(`Scout Email Finder v2 running on port ${PORT}`);
  console.log(`Google Maps API key: ${GMAPS_KEY ? 'SET ✓' : 'NOT SET — /enrich-place will return error'}`);
});
