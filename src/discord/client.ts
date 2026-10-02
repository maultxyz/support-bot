import { setTimeout as sleep } from "node:timers/promises";
import {
  Client,
  Events,
  GatewayIntentBits,
  OAuth2Scopes,
  Partials,
  PermissionFlagsBits,
  type AnyThreadChannel,
} from "discord.js";
import { forums, links, posts, removeGuildData, staffRoles } from "../db.js";
import { findSimilarIssues } from "../github.js";
import { logWarning, mirrorMessageToIssue, syncTopicLabels } from "../sync.js";
import { recordReply, scheduleVoteSync, startScheduledChecks, trackPost } from "../tracking.js";
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
      // Reactions on feature requests count as votes.
      GatewayIntentBits.GuildMessageReactions,
    ],
    // Reaction events for messages sent before the bot started only arrive as partials.
    partials: [Partials.Message, Partials.Reaction, Partials.User],
  });

  client.once(Events.ClientReady, async (ready) => {
    console.log(`Logged in to Discord as ${ready.user.tag} (in ${ready.guilds.cache.size} servers)`);
    console.log(`Invite link: ${inviteUrl(ready)}`);
    startScheduledChecks(ready);
    await registerCommands(ready).catch(logWarning("register slash commands"));
  });

  client.on(Events.GuildCreate, (guild) => console.log(`Joined server ${guild.name} (${guild.id})`));
  client.on(Events.GuildDelete, (guild) => {
    // Also fires during Discord outages; only forget a server the bot was actually removed from.
    if (!guild.available) return;
    removeGuildData(guild.id);
    console.log(`Removed from server ${guild.name} (${guild.id}); deleted its configuration`);
  });

  client.on(Events.ThreadCreate, (thread, newlyCreated) => {
    if (newlyCreated) onPostCreated(thread).catch(logWarning("send welcome message"));
  });

  client.on(Events.ThreadUpdate, (oldThread, newThread) => {
    if (posts.get(newThread.id)) posts.setTags(newThread.id, newThread.appliedTags);
    syncTopicLabels(oldThread, newThread).catch(logWarning("sync topic labels to GitHub"));
  });

  client.on(Events.ThreadDelete, (thread) => {
    links.removeByThread(thread.id);
    posts.remove(thread.id);
  });
  client.on(Events.ChannelDelete, (channel) => forums.remove(channel.id));
  client.on(Events.GuildRoleDelete, (role) => staffRoles.remove(role.id));

  client.on(Events.MessageCreate, (message) => {
    recordReply(message).catch(logWarning("record reply"));
    mirrorMessageToIssue(message).catch(logWarning("mirror Discord message to GitHub"));
  });

  client.on(Events.MessageReactionAdd, (reaction) => scheduleVoteSync(client, reaction.message));
  client.on(Events.MessageReactionRemove, (reaction) => scheduleVoteSync(client, reaction.message));
  client.on(Events.MessageReactionRemoveEmoji, (reaction) => scheduleVoteSync(client, reaction.message));
  client.on(Events.MessageReactionRemoveAll, (message) => scheduleVoteSync(client, message));

  client.on(Events.InteractionCreate, handleInteraction);

  client.on(Events.Error, (error) => console.error("Discord client error:", error));

  return client;
}

function inviteUrl(client: Client<true>) {
  return client.generateInvite({
    scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
    permissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageThreads,
      PermissionFlagsBits.ManageChannels,
    ],
  });
}

async function onPostCreated(thread: AnyThreadChannel) {
  const context = asForumThread(thread);
  if (!context) return;
  trackPost(thread, context.kind);

  // Search while waiting for the starter message; a failed search just leaves the section out.
  const { repo } = context;
  const similar = repo
    ? findSimilarIssues(repo, thread.name).catch((error) => {
        logWarning("search for similar issues")(error);
        return [];
      })
    : Promise.resolve([]);

  // Discord rejects messages in a new forum post until its starter message exists.
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(1_500);
    try {
      await thread.send(welcomeMessage(context.kind, thread, repo ? { repo, similar: await similar } : undefined));
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}
