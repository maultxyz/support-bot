import { setTimeout as sleep } from "node:timers/promises";
import { Client, Events, GatewayIntentBits, type AnyThreadChannel } from "discord.js";
import { forums, links, staffRoles } from "../db.js";
import { logWarning, mirrorMessageToIssue } from "../sync.js";
import { registerCommands } from "./commands.js";
import { handleInteraction } from "./interactions.js";
import { asForumThread, welcomeMessage } from "./util.js";

export function createDiscordClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      // Privileged: needed to copy post content into issues and mirror replies.
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, async (ready) => {
    console.log(`Logged in to Discord as ${ready.user.tag}`);
    await registerCommands(ready).catch(logWarning("register slash commands"));
  });

  client.on(Events.ThreadCreate, (thread, newlyCreated) => {
    if (newlyCreated) onPostCreated(thread).catch(logWarning("send welcome message"));
  });

  client.on(Events.ThreadDelete, (thread) => links.removeByThread(thread.id));
  client.on(Events.ChannelDelete, (channel) => forums.remove(channel.id));
  client.on(Events.GuildRoleDelete, (role) => staffRoles.remove(role.id));

  client.on(Events.MessageCreate, (message) => {
    mirrorMessageToIssue(message).catch(logWarning("mirror Discord message to GitHub"));
  });

  client.on(Events.InteractionCreate, handleInteraction);

  client.on(Events.Error, (error) => console.error("Discord client error:", error));

  return client;
}

async function onPostCreated(thread: AnyThreadChannel) {
  const context = asForumThread(thread);
  if (!context) return;

  // Discord rejects messages in a new forum post until its starter message exists.
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(1_500);
    try {
      await thread.send(welcomeMessage(context.kind));
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}
