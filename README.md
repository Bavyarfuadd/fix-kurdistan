# Slemani Fix AI

Citizens photograph a municipal issue (pothole, broken light, garbage…). Claude Vision
classifies it (type, severity, priority, description) and it appears on a live Leaflet map
and in an admin dashboard.

## Run
```bash
npm install
cp .env.example .env     # then edit: ANTHROPIC_API_KEY, ADMIN_KEY
npm start                # http://localhost:3000
```
- Citizen page: `/`   - Admin dashboard: `/admin.html` (login with ADMIN_KEY)
- Without `ANTHROPIC_API_KEY` the server uses a random MOCK analysis (testing only).
- GPS needs HTTPS on phones (localhost is fine on desktop). For phone testing use a tunnel
  (e.g. ngrok / cloudflared) or deploy to Render/Railway/Fly. Citizens can also tap the map to set the location.

## Google Maps (optional)
Set `GOOGLE_MAPS_API_KEY` in `.env` (enable **Maps JavaScript API** in Google Cloud, restrict the key by HTTP referrer).
Both maps then default to Google Roadmap and get a layer switcher (OpenStreetMap / Google Roadmap / Satellite / Hybrid).
Without a key, OpenStreetMap is used.

## API
| Method | Path | Notes |
|---|---|---|
| POST | /api/reports | multipart: `photo`, `lat`, `lng`, `note` |
| GET | /api/reports | public, `?severity=High&status=open` |
| GET | /api/admin/stats | header `x-admin-key` |
| GET | /api/admin/reports | header `x-admin-key` |
| PATCH | /api/admin/reports/:id | `status`, `severity`, `priority` |

## Before going public
- Set a strong `ADMIN_KEY`; serve over HTTPS.
- Add rate limiting (e.g. `express-rate-limit`) on POST /api/reports: each submission costs an API call.
- Uploads and `reports.db` live on local disk; use a persistent volume when deploying.
- Consider a Kurdish/Arabic UI and resizing images before upload to cut API cost.
