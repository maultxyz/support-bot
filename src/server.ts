import { verify } from "@octokit/webhooks-methods";
import type { Client } from "discord.js";
import { Hono } from "hono";
import { config } from "./config.js";
import { handleGithubEvent } from "./github-events.js";

export function createApp(client: Client) {
  const app = new Hono();

  app.get("/", (c) => c.text("support-bot is running"));

  app.get("/health", (c) => {
    const ready = client.isReady();
    return c.json(
      { status: ready ? "ok" : "starting", discord: ready ? "connected" : "disconnected", uptime: process.uptime() },
      ready ? 200 : 503,
    );
  });

  app.post("/webhooks/github", async (c) => {
    const signature = c.req.header("x-hub-signature-256");
    const event = c.req.header("x-github-event");
    const rawBody = await c.req.text();

    if (!signature || !event || !(await verify(config.GITHUB_WEBHOOK_SECRET, rawBody, signature))) {
      return c.json({ error: "invalid signature" }, 401);
    }
    if (event === "ping") return c.json({ ok: true, pong: true });

    // Acknowledge immediately; GitHub times out deliveries after 10 seconds.
    handleGithubEvent(client, event, JSON.parse(rawBody)).catch((error) =>
      console.error(`Failed to handle GitHub ${event} event:`, error),
    );
    return c.json({ ok: true }, 202);
  });

  return app;
}
