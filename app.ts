import {Webhook, WebhookUnbrandedRequiredHeaders, WebhookVerificationError} from "standardwebhooks";
import {RenderEvent, RenderService, WebhookPayload} from "./render";

interface Env {
    RENDER_WEBHOOK_SECRET: string;
    RENDER_API_URL?: string;
    RENDER_API_KEY: string;
    DISCORD_TOKEN: string;
    DISCORD_CHANNEL_ID: string;
}

interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
}

const DEFAULT_RENDER_API_URL = "https://api.render.com/v1";

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname !== "/webhook") {
            return new Response("Not Found", {status: 404});
        }
        if (request.method !== "POST") {
            return new Response("Method Not Allowed", {status: 405});
        }

        const missing = getMissingEnvVars(env);
        if (missing.length > 0) {
            console.error(`Missing env vars: ${missing.join(", ")}`);
            return new Response("", {status: 500});
        }

        let bodyText: string;
        try {
            bodyText = await request.text();
        } catch (error) {
            console.error(error);
            return new Response("", {status: 400});
        }

        const headers: WebhookUnbrandedRequiredHeaders = {
            "webhook-id": request.headers.get("webhook-id") || "",
            "webhook-timestamp": request.headers.get("webhook-timestamp") || "",
            "webhook-signature": request.headers.get("webhook-signature") || "",
        };

        try {
            validateWebhook(bodyText, headers, env.RENDER_WEBHOOK_SECRET);
        } catch (error) {
            console.error(error);
            if (error instanceof WebhookVerificationError) {
                return new Response("", {status: 400});
            }
            return new Response("", {status: 500});
        }

        let payload: WebhookPayload;
        try {
            payload = JSON.parse(bodyText);
        } catch (error) {
            console.error(error);
            return new Response("", {status: 400});
        }

        ctx.waitUntil(handleWebhook(payload, env));
        return new Response("{}", {
            status: 200,
            headers: {
                "Content-Type": "application/json",
            },
        });
    },
};

function getMissingEnvVars(env: Env): string[] {
    const missing: string[] = [];
    if (!env.RENDER_WEBHOOK_SECRET) missing.push("RENDER_WEBHOOK_SECRET");
    if (!env.RENDER_API_KEY) missing.push("RENDER_API_KEY");
    if (!env.DISCORD_TOKEN) missing.push("DISCORD_TOKEN");
    if (!env.DISCORD_CHANNEL_ID) missing.push("DISCORD_CHANNEL_ID");
    return missing;
}

function validateWebhook(
    bodyText: string,
    headers: WebhookUnbrandedRequiredHeaders,
    secret: string,
) {
    const wh = new Webhook(secret);
    wh.verify(bodyText, headers);
}

async function handleWebhook(payload: WebhookPayload, env: Env) {
    let service: RenderService | null = null;
    let event: RenderEvent | null = null;

    try {
        service = await fetchServiceInfo(payload, env);
    } catch (error) {
        console.error(error);
    }

    try {
        event = await fetchEventInfo(payload, env);
    } catch (error) {
        console.error(error);
    }

    try {
        await sendEventMessage(payload, service, event, env);
    } catch (error) {
        console.error(error);
    }
}

async function sendEventMessage(
    payload: WebhookPayload,
    service: RenderService | null,
    event: RenderEvent | null,
    env: Env,
) {
    const description = formatEventDescription(payload, event);
    const title = formatEventTitle(payload, service);

    const discordPayload: Record<string, unknown> = {
        embeds: [
            {
                color: 0xff5c88,
                title,
                description,
                ...(service?.dashboardUrl ? {url: service.dashboardUrl} : {}),
            },
        ],
    };

    if (service?.dashboardUrl) {
        discordPayload.components = [
            {
                type: 1,
                components: [
                    {
                        type: 2,
                        style: 5,
                        label: "View Logs",
                        url: `${service.dashboardUrl}/logs`,
                    },
                ],
            },
        ];
    }

    const res = await fetch(
        `https://discord.com/api/v10/channels/${env.DISCORD_CHANNEL_ID}/messages`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bot ${env.DISCORD_TOKEN}`,
            },
            body: JSON.stringify(discordPayload),
        },
    );

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(
            `Discord API error: ${res.status} ${res.statusText} - ${errorText}`,
        );
    }
}

function formatEventTitle(
    payload: WebhookPayload,
    service: RenderService | null,
): string {
    const name = service?.name || payload.data.serviceId || "Render Service";
    return `${name} · ${payload.type}`;
}

function formatEventDescription(
    payload: WebhookPayload,
    event: RenderEvent | null,
): string {
    if (payload.type === "server_failed") {
        const reason = event?.details?.reason;
        return formatFailureReason(reason);
    }

    const parts = [`Event: ${payload.type}`];
    if (event?.details) {
        const detailsText = safeJsonStringify(event.details);
        if (detailsText) {
            parts.push(`Details: ${detailsText}`);
        }
    }
    return truncate(parts.join("\n"), 4096);
}

function formatFailureReason(failureReason: any): string {
    if (failureReason?.nonZeroExit) {
        return `Exited with status ${failureReason.nonZeroExit}`;
    }
    if (failureReason?.oomKilled) {
        return "Out of Memory";
    }
    if (failureReason?.timedOutSeconds) {
        const reason = failureReason.timedOutReason || "";
        return `Timed out ${reason}`.trim();
    }
    if (failureReason?.unhealthy) {
        return failureReason.unhealthy;
    }
    return "Failed for unknown reason";
}

function safeJsonStringify(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    try {
        const result = JSON.stringify(value);
        return result || "";
    } catch {
        return "";
    }
}

function truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, maxLength - 3)}...`;
}

// fetchEventInfo fetches the event that triggered the webhook
// some events have additional information that isn't in the webhook payload
// for example, deploy events have the deploy id
async function fetchEventInfo(
    payload: WebhookPayload,
    env: Env,
): Promise<RenderEvent> {
    const res = await fetch(`${getRenderApiUrl(env)}/events/${payload.data.id}`,
        {
            method: "get",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                Authorization: `Bearer ${env.RENDER_API_KEY}`,
            },
        },
    );
    if (res.ok) {
        return res.json();
    }
    throw new Error(`unable to fetch event info; received code :${res.status}`);
}

async function fetchServiceInfo(
    payload: WebhookPayload,
    env: Env,
): Promise<RenderService> {
    const res = await fetch(
        `${getRenderApiUrl(env)}/services/${payload.data.serviceId}`,
        {
            method: "get",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                Authorization: `Bearer ${env.RENDER_API_KEY}`,
            },
        },
    );
    if (res.ok) {
        return res.json();
    }
    throw new Error(`unable to fetch service info; received code :${res.status}`);
}

function getRenderApiUrl(env: Env) {
    return env.RENDER_API_URL || DEFAULT_RENDER_API_URL;
}
