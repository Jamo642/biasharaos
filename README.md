# Biashara OS

Africa-first manufacturing ERP MVP for Kenyan SMEs, Jua Kali manufacturers, workshops, and small factories.

## Layout

```
africa/
├── backend/         Node server, schema, SQLite store
│   ├── server.js
│   ├── supabase-schema.sql
│   └── data/biashara.sqlite
├── frontend/        Static SPA (served by backend at /)
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── package.json
├── render.yaml
└── .env             Secrets (git-ignored; see .env.example)
```

## Run

```bash
npm start
```

Open `http://localhost:3000`.

The app stores the configured business workspace and all channel activity in `backend/data/biashara.sqlite`. Demo seeding is disabled by default (`DEMO_MODE=false`); configure the workspace from the dashboard before recording live business data.

## Sign in

The dashboard and every `/api/*` route require a signed-in account. Webhooks (`/api/webhooks/*`) stay open because Africa's Talking and M-Pesa call them directly.

- First visit: `/login.html` shows **Create owner account** (name, email, password of 8+ characters). This is only possible while no account exists.
- After that, sign in with email and password. Sessions last 7 days (HttpOnly cookie) and **Sign out** is at the bottom of the sidebar.
- Passwords are hashed with scrypt; logic lives in `backend/auth.js`. After 10 failed sign-ins, an IP is blocked for 15 minutes.

## Sandbox integrations

Copy `.env.example` to `.env` or export the variables before running the server.

Africa's Talking:

- `AFRICASTALKING_ENV=sandbox`
- `AFRICASTALKING_USERNAME=sandbox`
- `AFRICASTALKING_API_KEY=...`
- `AFRICASTALKING_VOICE_NUMBER=...`

Webhook URLs to configure in the Africa's Talking sandbox simulator:

- USSD: `/api/webhooks/africastalking/ussd`
- SMS: `/api/webhooks/africastalking/sms`
- Voice events: `/api/webhooks/africastalking/voice`

USSD is a guided worker workflow: `1` records production (product, quantity, material, and material quantity), `2` reports a machine problem, `3` checks the active job, `4` checks stock, and `5` opens a multi-turn AI chat. All actions use the same backend parser, business rules, and SQLite database as SMS, voice, and the dashboard. In the simulator, send `5*your question here` or enter `5` and continue replying to chat.

The voice webhook returns Africa's Talking XML. Press `1` for an AI business summary. If Africa's Talking sends a speech transcript field such as `speechText`, `speech`, `transcript`, `text`, or `message`, the webhook passes that transcript to the same AI handler.

M-Pesa Daraja:

- `MPESA_ENV=sandbox`
- `MPESA_CONSUMER_KEY=...`
- `MPESA_CONSUMER_SECRET=...`
- `MPESA_SHORTCODE=...`
- `MPESA_PASSKEY=...`
- `MPESA_CALLBACK_URL=https://your-public-url/api/webhooks/mpesa/callback`

AI providers:

- `NVIDIA_API_KEY=...`
- `NVIDIA_MODEL=meta/llama-3.1-70b-instruct`
- `OPENROUTER_API_KEY=...`
- `OPENROUTER_MODEL=nvidia/nemotron-3-super-120b-a12b:free` (with NVIDIA 70B as cross-provider fallback)

The keys stay on the server. Routine ERP commands still use the deterministic, audited action parser; the configured AI provider answers free-form read-only questions using the current dashboard context. Without a key, the app remains fully usable in local parser mode.

Daraja STK Push endpoint:

- `POST /api/mpesa/stk-push`

The hackathon demo buttons use the same backend logic as the webhooks. If credentials are configured, outbound SMS and voice notifications are sent through Africa's Talking sandbox. Without credentials, notifications are recorded as `SANDBOX_SENT` so the workflow still works.

## Core modules

- Production jobs and production entries
- Inventory and stock transactions with reorder alerts
- Orders, invoices, M-Pesa payment callback handling
- Machines, downtime events, repair history, escalation
- Biashara GPT structured action parser for English, Swahili, Sheng-style mixed input

## Jua Kali extensions

Built for how clusters actually run — group savings (chama), pay-per-job (piecework), one-view daily cashbook, AI pricing suggester, and proactive alerts.

| Endpoint | What it does |
| --- | --- |
| `GET /api/cashbook?date=YYYY-MM-DD` | Day's hesabu ya siku: inflow (sales + customer payments) vs outflow (expenses + purchases + supplier payments), with breakdown. Omit date for today. |
| `POST /api/pricing/suggest` | `{product, material_cost?, time_hours?, hourly_rate?, markup_pct?}` → suggested KSh price (median of past sales OR cost-plus, whichever is higher) + confidence. |
| `GET /api/chama/members` | List chama members with per-member balances + pool total. |
| `POST /api/chama/members` | `{name, phone?, role?}` — role one of `MEMBER` / `MWENYEKITI` / `KATIBU` / `MWEKA_HAZINA`. |
| `POST /api/chama/contribute` | `{member, amount, kind, note?}` — kind one of `DEPOSIT` / `WITHDRAW` / `LOAN` / `REPAY`. |
| `GET /api/chama/balance?member=…` | Member balance (omit `member` for whole-pool balance). |
| `GET /api/piecework?worker=…` | Unpaid piecework entries + totals per worker. |
| `POST /api/piecework` | `{worker, job, units, rate}` — amount = units × rate, locked at log time. |
| `POST /api/piecework/{id}/pay` | Mark entry paid; also writes a `WAGES` expense so the cashbook reflects reality. |
| `GET /api/ai/daily-summary?language=Swahili` | Returns `{inflow, outflow, net, low_stock, text}` where `text` is an SMS-shaped summary (`Hesabu ya leo …`). |
| `POST /api/ai/daily-summary/send` | `{recipients?, language?}` — composes the same summary and SMS'es it (defaults to the owner's phone). |
| `GET /api/ai/alerts?days=21` | Dormant customers + pricing anomalies (purchase-cost drift ≥15% week-over-week) + today's cashbook, in one call. |
| `POST /api/ai/receipt` | `{image_base64, mime}` or `{image_url}` → vision OCR returns `draft_expense` the fundi confirms via `POST /api/expenses`. Requires `OPENROUTER_API_KEY`. |

The AI tool-agent also exposes these as **callable tools** so Biashara GPT can chain them with sales/purchases/debts in one conversation:

- `suggest_price`, `get_daily_cashbook`
- `add_chama_member`, `log_chama_contribution`, `get_chama_balance`, `list_chama_members`
- `record_piecework`, `get_pending_piecework`

The agent now runs a **multi-step tool loop (up to 5 rounds)** with a system prompt pre-loaded with today's date, KSh, known customer/supplier/material names, and a Swahili verb cheat sheet (`nimeuza`, `nimenunua`, `nimelipa`, `alinilipa`, `nimetengeneza`, `ananidai`, `bei gani?`), so the model uses existing records instead of inventing new spellings and can chain reads + writes without a round-trip to the fundi.

## Production database

`backend/supabase-schema.sql` contains the PostgreSQL/Supabase schema with foreign keys, timestamps, audit tables, and RLS enabled.
