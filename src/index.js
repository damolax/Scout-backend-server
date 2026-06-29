const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Junk email patterns to filter out
const JUNK = [
  'sentry', 'wixpress', 'example.com', '.png', '.jpg', '.jpeg', '.gif',
  '.webp', '.svg', 'godaddy', 'schema.org', 'cloudflare', 'sentry.io',
  'your-email', 'email@domain', 'name@', 'user@', 'domain.com',
  'noreply', 'no-reply', 'donotreply', 'bounce', 'mailer-daemon',
  'postmaster', 'webmaster', 'abuse@', 'spam@', 'test@'
];

function cleanEmails(set) {
  return Array.from(set)
    .map(e => e.trim().toLowerCase().replace(/[.,;:)>]+$/, '').replace(/^[<(]+/, ''))
    .filter(e => /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(e))
    .filter(e => !JUNK.some(j => e.includes(j)) && e.length < 80)
    .filter((e, i, arr) => arr.indexOf(e) === i); // dedupe
}

function extractEmailsFromHtml(html) {
  const emails = new Set();
  // mailto links
  (html.match(/mailto:([^"'?<>\s,;]+)/gi) || [])
    .forEach(m => emails.add(m.replace(/mailto:/i, '')));
  // plain text emails
  (html.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) || [])
    .forEach(e => emails.add(e));
  return emails;
}

async function fetchPage(url, timeout = 8000) {
  try {
    const res = await axios.get(url, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      maxRedirects: 5,
    });
    return res.data || '';
  } catch {
    return '';
  }
}

async function findWebsiteFromGoogleMaps(profileUrl) {
  // We can't scrape Google Maps directly (JS-rendered), but we can try
  // extracting domain hints from the URL or return null for extension to handle
  return null;
}

async function crawlSiteForEmail(websiteUrl) {
  if (!websiteUrl) return { emails: [], phones: [], reached: 0 };

  let origin;
  try {
    const u = new URL(websiteUrl.startsWith('http') ? websiteUrl : 'https://' + websiteUrl);
    origin = u.origin;
  } catch {
    return { emails: [], phones: [], reached: 0 };
  }

  const paths = ['', '/contact', '/contact-us', '/contactus', '/about', '/about-us',
    '/get-in-touch', '/reach-us', '/support', '/help', '/info'];

  const emails = new Set();
  const phones = new Set();
  let reached = 0;

  for (const p of paths) {
    const url = origin + p;
    const html = await fetchPage(url);
    if (!html) continue;
    reached++;

    const found = extractEmailsFromHtml(html);
    found.forEach(e => emails.add(e));

    // Extract phones
    (html.match(/(?:tel:|phone:?\s*)?(?:\+?[\d][\d\s\-().]{7,}[\d])/gi) || [])
      .forEach(ph => {
        const clean = ph.replace(/tel:/i, '').trim();
        if (clean.replace(/\D/g, '').length >= 7) phones.add(clean);
      });

    if (emails.size >= 3) break;
  }

  return {
    emails: cleanEmails(emails).slice(0, 5),
    phones: Array.from(phones).slice(0, 3),
    reached,
  };
}

// ── ROUTES ──────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Scout Email Finder v1', timestamp: new Date().toISOString() });
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

// Batch: find emails for multiple businesses
app.post('/batch-find-emails', async (req, res) => {
  const { businesses } = req.body; // [{id, website, business_name}]
  if (!businesses || !Array.isArray(businesses)) {
    return res.status(400).json({ error: 'businesses array required' });
  }

  const results = [];
  for (const biz of businesses.slice(0, 50)) { // cap at 50 per batch
    const result = await crawlSiteForEmail(biz.website);
    results.push({ id: biz.id, business_name: biz.business_name, ...result });
    // Small delay to be polite
    await new Promise(r => setTimeout(r, 300));
  }

  res.json({ success: true, results });
});

// Detect industry from business name + signals
app.post('/detect-industry', async (req, res) => {
  const { business_name, category, description } = req.body;
  const text = [business_name, category, description].filter(Boolean).join(' ').toLowerCase();
  const industry = detectIndustry(text);
  res.json({ industry });
});

// Industry detection logic (mirrors client-side)
function detectIndustry(text) {
  const map = [
    { name: 'restaurant', keys: ['restaurant','cafe','coffee','diner','bistro','eatery','food','catering','bakery','pizza','sushi','bar','pub','kitchen','grill','burger','chicken','rice','noodle','jollof','suya','buka','mama put'] },
    { name: 'beauty', keys: ['salon','beauty','hair','nail','spa','barber','lash','brow','makeup','waxing','threading','tanning','aesthetic','skincare','facial','massage'] },
    { name: 'home_services', keys: ['plumber','plumbing','electrician','hvac','heating','cleaning','cleaner','lawn','landscaping','pest','roofing','handyman','painter','carpenter','flooring','renovation','remodel','contractor'] },
    { name: 'healthcare', keys: ['clinic','doctor','physician','dentist','dental','optometrist','physiotherapy','physio','chiropractic','therapy','therapist','medical','health','pharmacy','nurse','hospital'] },
    { name: 'fitness', keys: ['gym','fitness','trainer','yoga','pilates','crossfit','bootcamp','martial arts','boxing','swimming','sports','coach','workout','studio'] },
    { name: 'real_estate', keys: ['real estate','property','realtor','estate agent','letting','rental','landlord','tenant','housing','mortgage','development','developer'] },
    { name: 'legal', keys: ['law','solicitor','attorney','lawyer','legal','barrister','notary','paralegal','conveyancing','litigation','advocate'] },
    { name: 'accounting', keys: ['accountant','accounting','bookkeeper','bookkeeping','financial advisor','tax','audit','cpa','wealth','mortgage broker'] },
    { name: 'automotive', keys: ['auto','car','vehicle','mechanic','garage','repair','detailing','tyres','tires','workshop','dealership','mot'] },
    { name: 'education', keys: ['school','tutor','tutoring','course','training','e-learning','workshop','academy','learning','teacher','instructor','college','university'] },
    { name: 'events', keys: ['event','venue','wedding','planner','dj','entertainer','photographer','videographer','rental','entertainment','catering','party'] },
    { name: 'hospitality', keys: ['hotel','hostel','motel','bnb','bed and breakfast','guesthouse','resort','lodge','inn','travel','tour','holiday'] },
    { name: 'retail', keys: ['shop','store','retail','boutique','ecommerce','merchandise','inventory','wholesale','brand','market'] },
    { name: 'construction', keys: ['construction','builder','architect','civil','structural','project','site','contractor','subcontractor','build'] },
    { name: 'logistics', keys: ['courier','freight','moving','delivery','dispatch','logistics','transport','fleet','shipping','haulage'] },
    { name: 'professional_services', keys: ['agency','consultant','marketing','it service','hr','virtual assistant','staffing','recruitment'] },
    { name: 'childcare', keys: ['daycare','nursery','preschool','childcare','nanny','kindergarten','creche','after school','kids','children'] },
    { name: 'pet', keys: ['vet','veterinary','groomer','grooming','pet','dog','cat','kennel','boarding','animal'] },
    { name: 'cleaning', keys: ['cleaning','cleaner','maid','janitorial','housekeeping','domestic','laundry','dry clean'] },
    { name: 'security', keys: ['security','guard','cctv','alarm','surveillance','protection','patrol'] },
  ];

  for (const ind of map) {
    if (ind.keys.some(k => text.includes(k))) return ind.name;
  }
  return 'general';
}

app.listen(PORT, () => {
  console.log(`Scout Email Finder running on port ${PORT}`);
});
