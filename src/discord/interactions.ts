import {
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from "discord.js";
import type { IssueKind } from "../config.js";
import { links } from "../db.js";
import { getIssue } from "../github.js";
import {
  createIssueForThread,
  linkExistingIssue,
  resolveThread,
  SyncError,
  unlinkThread,
} from "../sync.js";
import { handleSetupCommand } from "./setup.js";
import {
  asForumThread,
  ButtonIds,
  Colors,
  isStaff,
  KIND_LABEL,
  linkEmbed,
  resolveOnlyRow,
} from "./util.js";

type ThreadInteraction = ChatInputCommandInteraction | ButtonInteraction;

export async function handleInteraction(interaction: Interaction) {
  if (!interaction.isChatInputCommand() && !interaction.isButton()) return;

  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "setup" && interaction.inCachedGuild()) await handleSetupCommand(interaction);
      else if (interaction.commandName === "issue") await handleIssueCommand(interaction);
      else if (interaction.commandName === "resolve") await handleResolve(interaction);
    } else if (interaction.customId === ButtonIds.createIssue) {
      await handleCreateButton(interaction);
    } else if (interaction.customId === ButtonIds.resolve) {
      await handleResolve(interaction);
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

function requireStaff(interaction: ThreadInteraction) {
  if (!isStaff(interaction)) throw new SyncError("Only staff can manage GitHub issues.");
}

function requireUnlinked(threadId: string) {
  const link = links.byThread(threadId);
  if (link) throw new SyncError(`Already tracked as [${link.repo}#${link.issueNumber}](${link.issueUrl}).`);
}

async function handleIssueCommand(interaction: ChatInputCommandInteraction) {
  const { thread, kind } = requireForumThread(interaction);
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "status") return showStatus(interaction, thread.id);

  requireStaff(interaction);

  switch (subcommand) {
    case "create": {
      requireUnlinked(thread.id);
      await interaction.deferReply();
      const type = (interaction.options.getString("type") as IssueKind | null) ?? kind;
      const title = interaction.options.getString("title") ?? undefined;
      const link = await createIssueForThread(thread, type, interaction.user, title);
      await interaction.editReply({ embeds: [linkEmbed(link, "GitHub issue created")] });
      return;
    }
    case "link": {
      requireUnlinked(thread.id);
      await interaction.deferReply();
      const number = interaction.options.getInteger("number", true);
      const link = await linkExistingIssue(thread, kind, number, interaction.user);
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
  const issue = await getIssue(link.issueNumber);
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
  const { thread, kind } = requireForumThread(interaction);
  requireStaff(interaction);
  requireUnlinked(thread.id);

  await interaction.deferReply();
  const link = await createIssueForThread(thread, kind, interaction.user);
  await interaction.editReply({ embeds: [linkEmbed(link, "GitHub issue created")] });

  // Drop the "Track on GitHub" button from the welcome message now that it's done.
  await interaction.message.edit({ components: [resolveOnlyRow()] }).catch(() => {});
}

async function handleResolve(interaction: ThreadInteraction) {
  const { thread } = requireForumThread(interaction);
  const staff = isStaff(interaction);
  if (!staff && interaction.user.id !== thread.ownerId) {
    throw new SyncError("Only the person who opened this post or staff can resolve it.");
  }

  const closeIssue =
    staff && (interaction.isChatInputCommand() ? (interaction.options.getBoolean("close_issue") ?? true) : true);

  await interaction.deferReply();
  const { link, closedIssue } = await resolveThread(thread, interaction.user, closeIssue);

  const lines = [`Marked as resolved by ${interaction.user}. This post is now closed.`];
  if (closedIssue && link) lines.push(`Closed [${link.repo}#${link.issueNumber}](${link.issueUrl}).`);
  lines.push("Send a message here if you need to reopen it.");

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(Colors.merged).setTitle("Resolved").setDescription(lines.join("\n"))],
  });
  await thread.setArchived(true, `Resolved by ${interaction.user.username}`);
}
