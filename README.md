# Scout Email Finder — Backend Server

Crawls business websites to find contact emails. Used as fallback when the Chrome Extension isn't available.

## Deploy to Render (Free, 5 minutes)

1. Push this folder to a GitHub repo
2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Name**: scout-email-finder
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
5. Click Deploy
6. Copy your Render URL (e.g. `https://scout-email-finder.onrender.com`)
7. Paste it into Scout App → Settings → Backend Server URL

## Local development

```bash
npm install
npm run dev
```

Server runs on http://localhost:3001

## Endpoints

- `GET /` — health check
- `POST /find-email` — `{ website, business_name }` → finds emails
- `POST /batch-find-emails` — `{ businesses: [{id, website, business_name}] }` → batch
- `POST /detect-industry` — `{ business_name }` → industry name

## Notes

- Free Render instances sleep after 15 min of inactivity. First request after sleep takes ~30s to wake up.
- The Scout App pings the server on load to wake it early.
- Crawls up to 11 pages per business (home, /contact, /about, etc.)
- Max 50 businesses per batch request
