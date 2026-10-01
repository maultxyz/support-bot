import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { db } from "./db.js";
import { createDiscordClient } from "./discord/client.js";
import { createApp } from "./server.js";

const client = createDiscordClient();

const server = serve({ fetch: createApp(client).fetch, port: config.PORT }, (info) => {
  console.log(`HTTP server listening on port ${info.port}`);
});

await client.login(config.DISCORD_TOKEN);

async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down`);
  await client.destroy();
  server.close();
  db.close();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
