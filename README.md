# UK Brand Lover Messenger AI Bot

Production-ready Facebook Messenger AI chatbot server for `UK Brand Lover` built with Node.js, Express, Gemini, Supabase, and a Google Apps Script web app for Google Sheets.

## Features

- Meta Messenger webhook verification and message handling
- Human-like AI replies using Gemini
- Customer memory stored in Supabase
- Chat history stored in Supabase
- Order creation when required details are complete
- Human handoff flag for complaints or sensitive cases
- Typing indicator before bot replies
- Google Apps Script based Google Sheets sync for products, orders, and customer list
- Strong error handling so the server does not crash on a single failure

## Project Files

- `index.js` - main Express server and chatbot logic
- `package.json` - dependencies and scripts
- `.env.example` - required environment variables
- `supabase.sql` - database schema

## Environment Variables

Copy `.env.example` to `.env` and fill in the values:

```env
PAGE_ACCESS_TOKEN=
VERIFY_TOKEN=
APP_SECRET=
GEMINI_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
GOOGLE_SHEET_ID=
GOOGLE_APPS_SCRIPT_URL=
GOOGLE_APPS_SCRIPT_SECRET=
PORT=3000
```

## Setup Guide

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example`.

3. In Supabase SQL Editor, run the SQL from `supabase.sql`.

4. Start the server locally:

```bash
npm run dev
```

or

```bash
npm start
```

5. Open:

```text
http://localhost:3000/
```

Expected response:

```text
Messenger AI Bot is running
```

## Supabase Tables

This project uses these tables:

1. `customers`
2. `messages`
3. `orders`

The schema is included in `supabase.sql`.

## How It Works

1. Meta sends a webhook event to `GET /webhook` for verification.
2. Meta sends user messages to `POST /webhook`.
3. The app verifies the webhook signature using `APP_SECRET`.
4. The app stores the user message in Supabase.
5. The app loads customer memory and recent chat history.
6. Gemini generates a short human-like response in JSON format.
7. The app updates customer memory.
8. If order details are complete, the app creates an order row.
9. The bot sends `typing_on` and then replies via Messenger Send API.

## Google Sheets Via Apps Script

This project now uses a deployed Google Apps Script Web App instead of a Google service account.

1. Use the Google Sheet ID below or replace it with your own.
2. Deploy an Apps Script Web App connected to the sheet.
3. The Apps Script should support these actions:

```text
getProductsFromSheet
addOrderToSheet
updateCustomerInSheet
```

4. Add these environment variables:

```env
GOOGLE_SHEET_ID=1qkWnE0y3c_zkzYs6JTPyA9Ck_LbOdSPY2yGs4sxssLU
GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/AKfycbwmv98n24_tlwO3RaEGXVxP6Q0awtTya1SwpzA4asOnBylsFI7ljjnsXmmTXmt5RxMr/exec
GOOGLE_APPS_SCRIPT_SECRET=uk_brand_lover_sheet_secret_2026
```

Suggested sheet tabs:

```text
Products
Orders
Customers
```

Suggested product columns:

```text
name | sku | category | price | stock | note
```

Important:

- The bot prompt tells Gemini not to invent product data.
- If the Apps Script service is unavailable, the bot continues using Supabase memory and Messenger replies.
- If product lookup is missing or unclear, the bot asks for product name or screenshot.

## Meta Developer Dashboard Webhook Setup

1. Go to `Meta for Developers`.
2. Open your app.
3. Add `Messenger` product if not already added.
4. In `Messenger > Settings > Webhooks`, click `Add Callback URL`.
5. Set callback URL:

```text
https://your-domain.com/webhook
```

6. Set verify token to the same value as `VERIFY_TOKEN` in `.env`.
7. Subscribe to the `messages` and `messaging_postbacks` fields if needed.
8. Generate a Page Access Token and set it as `PAGE_ACCESS_TOKEN`.
9. Add your page subscription to the connected Facebook Page.

## How To Test

### Local Test

1. Run the server.
2. Expose it publicly using a tunnel like `ngrok` or `Cloudflare Tunnel`.
3. Use the public HTTPS URL in Meta webhook settings.
4. Send a message to your Facebook Page inbox.

### Test Verification Endpoint

Use a browser or curl:

```bash
curl "http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=YOUR_VERIFY_TOKEN&hub.challenge=12345"
```

Expected response:

```text
12345
```

### Test Root Endpoint

```bash
curl http://localhost:3000/
```

### Test Messenger Bot Flow

Try these sample customer messages:

```text
Hi, this bag available?
```

```text
Apnader kache black sneaker ache?
```

```text
Order korte chai. Amar name Rahim, phone 01712345678, address Dhanmondi Dhaka.
```

```text
I got the wrong product.
```

Expected behavior:

- Natural short reply
- Banglish response when appropriate
- Complaint triggers human handoff
- Sensitive information warning if someone shares OTP or card info
- Order gets saved only when required details are complete

## Deploy On Render

1. Push the project to GitHub.
2. Create a new `Web Service` in Render.
3. Connect the repository.
4. Use these settings:

```text
Build Command: npm install
Start Command: npm start
```

5. Add all environment variables in Render dashboard.
6. Deploy.
7. Use the Render service URL as your webhook callback.

## Deploy On Railway

1. Push the project to GitHub.
2. Create a new Railway project.
3. Deploy from GitHub repo.
4. Add all environment variables.
5. Railway will detect Node.js automatically.
6. Start command:

```text
npm start
```

7. Use the Railway generated public domain for the webhook.

## Security Notes

- Never commit your real `.env` file.
- `APP_SECRET` is used to verify webhook signatures.
- `SUPABASE_SERVICE_ROLE_KEY` must stay private.
- `GOOGLE_APPS_SCRIPT_SECRET` must stay private.
- The bot blocks sharing of OTP, PIN, password, or card number.

## Production Notes

- Add page inbox review flow if you want human agent takeover from CRM.
- Add rate limiting and request logging for heavier traffic.
- Add stricter Apps Script response validation if multiple systems will write into the same sheet.
- Use a job queue later if message volume becomes high.

## Main Functions

The project includes these beginner-friendly modular functions:

- `verifyWebhook()`
- `handleIncomingMessage()`
- `getOrCreateCustomer()`
- `saveMessage()`
- `getRecentMessages()`
- `generateAIReply()`
- `updateCustomerMemory()`
- `createOrderIfComplete()`
- `sendTyping()`
- `sendMessengerMessage()`
- `getProductsFromSheet()`
- `addOrderToSheet(order)`
- `updateCustomerInSheet(customer)`
