import {
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type AnyThreadChannel,
  type ChatInputCommandInteraction,
  type Interaction,
  type StringSelectMenuInteraction,
  type User,
} from "discord.js";
import { config, type IssueKind } from "../config.js";
import { links, posts } from "../db.js";
import { getIssue } from "../github.js";
import { createIssueForThread, linkExistingIssue, resolveThread, SyncError, unlinkThread } from "../sync.js";
import { INACTIVE_REASON, reactivatePost } from "../tracking.js";
import { handleSetupCommand } from "./setup.js";
import { handleStatsCommand } from "./stats.js";
import {
  asForumThread,
  ComponentIds,
  Colors,
  isStaff,
  KIND_LABEL,
  linkEmbed,
  RESOLVE_REASONS,
  resolveReasonPicker,
  setTopicTags,
  updateThread,
  WelcomeFields,
  withoutComponent,
  type ResolveReason,
} from "./util.js";

type ThreadInteraction = ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction;

export async function handleInteraction(interaction: Interaction) {
  if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isStringSelectMenu()) return;

  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "setup" && interaction.inCachedGuild()) await handleSetupCommand(interaction);
      else if (interaction.commandName === "issue") await handleIssueCommand(interaction);
      else if (interaction.commandName === "resolve") await handleResolve(interaction);
      else if (interaction.commandName === "stats" && interaction.inCachedGuild()) {
        requireStaff(interaction, "Only staff can see support stats.");
        await handleStatsCommand(interaction);
      }
    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId === ComponentIds.topics) await handleTopicSelect(interaction);
    } else if (interaction.customId === ComponentIds.createIssue) {
      await handleCreateButton(interaction);
    } else if (interaction.customId === ComponentIds.resolve) {
      await handleResolve(interaction);
    } else if (interaction.customId.startsWith(ComponentIds.resolveAs)) {
      await handleResolveAs(interaction);
    } else if (interaction.customId === ComponentIds.reactivate) {
      await handleReactivate(interaction);
    }
  } catch (error) {
    const content =
      error instanceof SyncError ? error.message : "Something went wrong. Please try again or check the bot logs.";
    if (!(error instanceof SyncError)) console.error("Interaction failed:", error);

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content, embeds: [], components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
}

function requireForumThread(interaction: ThreadInteraction) {
  const context = asForumThread(interaction.channel);
  if (!context) throw new SyncError("Use this inside a post in the support or feature-request forum.");
  return context;
}

function requireStaff(interaction: ThreadInteraction, message = "Only staff can manage GitHub issues.") {
  if (!isStaff(interaction)) throw new SyncError(message);
}

function requireRepo(repo: string | null) {
  if (!repo) throw new SyncError("This forum has no GitHub repo yet. Set one with `/setup forum add`.");
  return repo;
}

function requireUnlinked(threadId: string) {
  const link = links.byThread(threadId);
  if (link) throw new SyncError(`Already tracked as [${link.repo}#${link.issueNumber}](${link.issueUrl}).`);
}

async function handleIssueCommand(interaction: ChatInputCommandInteraction) {
  const { thread, kind, repo } = requireForumThread(interaction);
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "status") return showStatus(interaction, thread.id);

  requireStaff(interaction);

  switch (subcommand) {
    case "create": {
      requireUnlinked(thread.id);
      await interaction.deferReply();
      const type = (interaction.options.getString("type") as IssueKind | null) ?? kind;
      const title = interaction.options.getString("title") ?? undefined;
      const link = await createIssueForThread(thread, type, requireRepo(repo), interaction.user, title);
      await interaction.editReply({ embeds: [linkEmbed(link, "GitHub issue created")] });
      return;
    }
    case "link": {
      requireUnlinked(thread.id);
      const target = requireRepo(repo);
      await interaction.deferReply();
      const number = interaction.options.getInteger("number", true);
      const link = await linkExistingIssue(thread, kind, target, number, interaction.user);
      await interaction.editReply({ embeds: [linkEmbed(link, "Linked to GitHub issue")] });
      return;
    }
    case "unlink": {
      const link = await unlinkThread(thread);
      await interaction.reply({
        content: `Unlinked from ${link.repo}#${link.issueNumber}. The GitHub issue was left unchanged.`,
      });
      return;
    }
  }
}

async function showStatus(interaction: ChatInputCommandInteraction, threadId: string) {
  const link = links.byThread(threadId);
  if (!link) throw new SyncError("This post isn't linked to a GitHub issue.");

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const issue = await getIssue(link.repo, link.issueNumber);
  if (!issue) throw new SyncError(`Issue #${link.issueNumber} no longer exists. Use \`/issue unlink\` to clear it.`);

  const open = issue.state === "open";
  const labels = issue.labels.map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
  const assignees = issue.assignees?.map((a) => a.login) ?? [];

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(open ? Colors.success : Colors.merged)
        .setTitle(`${link.repo}#${issue.number}: ${issue.title}`.slice(0, 256))
        .setURL(issue.html_url)
        .addFields(
          { name: "State", value: open ? "Open" : `Closed (${issue.state_reason ?? "completed"})`, inline: true },
          { name: "Type", value: KIND_LABEL[link.kind], inline: true },
          { name: "Comments", value: String(issue.comments), inline: true },
          { name: "Labels", value: labels.join(", ") || "None", inline: true },
          { name: "Assignees", value: assignees.join(", ") || "None", inline: true },
        ),
    ],
  });
}

async function handleCreateButton(interaction: ButtonInteraction) {
  const { thread, kind, repo } = requireForumThread(interaction);
  requireStaff(interaction);
  requireUnlinked(thread.id);
  const target = requireRepo(repo);

  await interaction.deferReply();
  const link = await createIssueForThread(thread, kind, target, interaction.user);
  await interaction.editReply({ embeds: [linkEmbed(link, "GitHub issue created")] });

  // Drop the "Track on GitHub" button from the welcome message now that it's done.
  await interaction.message
    .edit({ components: withoutComponent(interaction.message, ComponentIds.createIssue) })
    .catch(() => {});
}

async function handleTopicSelect(interaction: StringSelectMenuInteraction) {
  const { thread } = requireForumThread(interaction);
  if (!isStaff(interaction) && interaction.user.id !== thread.ownerId) {
    throw new SyncError("Only the person who opened this post or staff can choose its tags.");
  }

  const applied = await setTopicTags(thread, interaction.values);
  const [welcome] = interaction.message.embeds;

  // Swap the prompt for the chosen tags and drop the menu; tags can still be edited from the post itself.
  const embed = welcome ? EmbedBuilder.from(welcome) : new EmbedBuilder().setColor(Colors.brand);
  embed.setFields(
    ...(welcome?.fields ?? []).filter((field) => field.name !== WelcomeFields.topicPrompt),
    {
      name: WelcomeFields.taggedAs,
      value: applied.map((tag) => `${tag.emoji?.name ?? ""} **${tag.name}**`.trim()).join(", ") || "No tags",
    },
  );

  await interaction.update({
    embeds: [embed],
    components: withoutComponent(interaction.message, ComponentIds.topics),
  });
}

/** `/resolve` and the "Mark resolved" button. */
async function handleResolve(interaction: ChatInputCommandInteraction | ButtonInteraction) {
  const { thread } = requireForumThread(interaction);
  const staff = isStaff(interaction);
  if (!staff && interaction.user.id !== thread.ownerId) {
    throw new SyncError("Only the person who opened this post or staff can resolve it.");
  }

  // Staff pressing the button pick a reason first; the author can only mark their post Resolved.
  if (interaction.isButton() && staff) {
    await interaction.reply({
      content: "Why is this post being closed?",
      components: [resolveReasonPicker()],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const options = interaction.isChatInputCommand() ? interaction.options : null;
  const reason = (options?.getString("reason") as ResolveReason | null) ?? "resolved";
  if (reason !== "resolved" && !staff) throw new SyncError("Only staff can close a post as Added or Rejected.");
  const closeIssue = staff && (options?.getBoolean("close_issue") ?? true);

  await interaction.deferReply();
  await resolvePost(thread, interaction.user, reason, closeIssue, (embed) =>
    interaction.editReply({ embeds: [embed] }),
  );
}

/** A reason button from the staff picker. */
async function handleResolveAs(interaction: ButtonInteraction) {
  const { thread } = requireForumThread(interaction);
  requireStaff(interaction);
  const reason = interaction.customId.slice(ComponentIds.resolveAs.length);
  if (!(reason in RESOLVE_REASONS)) return;

  await interaction.deferUpdate();
  await resolvePost(thread, interaction.user, reason as ResolveReason, true, (embed) =>
    thread.send({ embeds: [embed] }),
  );
  await interaction.editReply({
    content: `Closed as **${RESOLVE_REASONS[reason as ResolveReason].label}**.`,
    components: [],
  });
}

/** The "Reactivate" button on a post the bot closed for inactivity. */
async function handleReactivate(interaction: ButtonInteraction) {
  const { thread } = requireForumThread(interaction);
  if (!isStaff(interaction) && interaction.user.id !== thread.ownerId) {
    throw new SyncError("Only the person who opened this post or staff can reactivate it.");
  }

  const components = withoutComponent(interaction.message, ComponentIds.reactivate);
  await interaction.deferUpdate();

  // Already reopened by a message, or closed again for another reason since.
  if (posts.get(thread.id)?.closeReason !== INACTIVE_REASON) {
    await interaction.followUp({ content: "This post isn't closed for inactivity anymore.", flags: MessageFlags.Ephemeral });
    // Messages in a closed post can't be edited, so the button only goes away if the post is open.
    if (!thread.archived) await interaction.editReply({ components }).catch(() => {});
    return;
  }

  await reactivatePost(thread, interaction.user);
  await interaction.editReply({ components });
  await thread.send({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.success)
        .setTitle("🔄 Reactivated")
        .setDescription(`Reopened by ${interaction.user}. The team will take another look.`),
    ],
    allowedMentions: { parse: [] },
  });
}

/** Closes the linked issue if asked, announces the outcome, then tags and closes the post. */
async function resolvePost(
  thread: AnyThreadChannel,
  actor: User,
  reason: ResolveReason,
  closeIssue: boolean,
  announce: (embed: EmbedBuilder) => Promise<unknown>,
) {
  const info = RESOLVE_REASONS[reason];
  const { link, closedIssue, status } = await resolveThread(thread, actor, {
    closeIssue,
    reason: info.closeAs,
    label: info.label,
  });

  const lines = [`Closed as **${info.label}** by ${actor}.`];
  if (closedIssue && link) lines.push(`Closed [${link.repo}#${link.issueNumber}](${link.issueUrl}).`);
  lines.push("Send a message here if you need to reopen it.");
  await announce(
    new EmbedBuilder()
      .setColor(info.color)
      .setTitle(`${info.emoji} ${info.label}`)
      .setDescription(lines.join("\n")),
  );

  posts.markClosed(thread.id, reason);
  await updateThread(thread, {
    // Added/Rejected replace the status tag. Resolved keeps a still-open issue's Pending tag.
    status: info.status ?? (link && !closedIssue ? status : null),
    addTags: info.status ? [] : [config.RESOLVED_TAG_NAME],
    removeTags: info.status ? [config.RESOLVED_TAG_NAME] : [],
    archived: true,
    reason: `Closed as ${info.label} by ${actor.username}`,
  });
}
