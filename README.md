# Example to Send a Discord Message from a Render Webhook

This example sends a message to Discord when receiving a server failed webhook. It is deployed as a Cloudflare Worker.

# Prerequisites
If you haven't already, [sign up for a Render account](https://dashboard.render.com/register).
Creating webhooks on Render requires a Professional plan or higher. You can [view and upgrade your plan](https://dashboard.render.com/billing/update-plan) in the Render Dashboard.

You will also need a Cloudflare account and a Discord app token.

## Deploy to Cloudflare Workers

1. Install dependencies:

```bash
pnpm install
```

2. Set secrets:

```bash
wrangler secret put RENDER_WEBHOOK_SECRET
wrangler secret put RENDER_API_KEY
wrangler secret put DISCORD_TOKEN
wrangler secret put DISCORD_CHANNEL_ID
```

(Optional) set `RENDER_API_URL` if you use a non-default Render API base URL.

3. Deploy:

```bash
pnpm run deploy
```

4. Follow [instructions](https://render.com/docs/webhooks) to create a webhook with the URL from your worker and the `/webhook` path.
5. Follow [instructions](https://render.com/docs/api#1-create-an-api-key) to create a Render API Key.
6. Follow [instructions](https://discord.com/developers/docs/quick-start/getting-started#step-1-creating-an-app) to create a Discord App and copy the token.
7. Navigate to the installation settings for your app and
   - add `bot` scope
   - add `SendMessages` and `ViewChannels` permissions

## Developing

Once you've created a project and installed dependencies with `pnpm install`, start a development server:

```bash
pnpm run dev
```

## Building

```bash
pnpm run build
```
