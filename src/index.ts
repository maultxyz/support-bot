import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { db } from "./db.js";
import { createDiscordClient } from "./discord/client.js";
import { createApp } from "./server.js";

const client = createDiscordClient();

const server = serve({ fetch: createApp(client).fetch, port: config.PORT }, (info) => {
  console.log(`HTTP server listening on port ${info.port}`);
});

try {
  await client.login(config.DISCORD_TOKEN);
} catch (error) {
  console.error(describeLoginError(error));
  process.exit(1);
}

function describeLoginError(error: unknown) {
  const { message, code } = error as { message?: string; code?: string };
  if (message === "Used disallowed intents") {
    return (
      "Discord rejected the bot's gateway intents. In the Discord Developer Portal, open your app → Bot → " +
      "Privileged Gateway Intents and enable \"Message Content Intent\", then restart."
    );
  }
  if (code === "TokenInvalid") return "DISCORD_TOKEN is invalid. Reset it under Bot → Reset Token and update the env var.";
  return error;
}

async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down`);
  await client.destroy();
  server.close();
  db.close();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
