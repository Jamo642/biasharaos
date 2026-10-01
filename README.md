# Biashara OS

Africa-first manufacturing ERP MVP for Kenyan SMEs, Jua Kali manufacturers, workshops, and small factories.

## Run

```bash
npm start
```

Open `http://localhost:3000`.

The app stores the configured business workspace and all channel activity in `data/biashara.sqlite`. Demo seeding is disabled by default (`DEMO_MODE=false`); configure the workspace from the dashboard before recording live business data.

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

## Production database

`supabase-schema.sql` contains the PostgreSQL/Supabase schema with foreign keys, timestamps, audit tables, and RLS enabled.
