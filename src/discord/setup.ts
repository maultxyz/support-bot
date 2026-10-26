import {
  ChannelType,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ForumChannel,
  type ModalSubmitInteraction,
} from "discord.js";
import { config, type IssueKind } from "../config.js";
import { forums, guildSettings, staffRoles } from "../db.js";
import { defaultRepo, getRepository } from "../github.js";
import { SyncError } from "../sync.js";
import { formatDuration } from "../tracking.js";
import { DEFAULT_DETAIL_QUESTIONS, detailQuestions, MAX_DETAIL_QUESTIONS, MAX_QUESTION_LENGTH } from "./details.js";
import { Colors, ComponentIds, KIND_LABEL } from "./util.js";

/** Permissions the bot needs inside a managed forum. */
const REQUIRED_PERMISSIONS = {
  "View Channel": PermissionFlagsBits.ViewChannel,
  "Send Messages in Threads": PermissionFlagsBits.SendMessagesInThreads,
  "Embed Links": PermissionFlagsBits.EmbedLinks,
  "Read Message History": PermissionFlagsBits.ReadMessageHistory,
  "Manage Threads": PermissionFlagsBits.ManageThreads,
} as const;

const MAX_FORUM_TAGS = 20;

/** Tags the bot applies. Status tags are moderated so members can't set them on their own posts. */
const BOT_TAGS = [
  { name: config.PENDING_TAG_NAME, moderated: true },
  { name: config.ADDED_TAG_NAME, moderated: true },
  { name: config.REJECTED_TAG_NAME, moderated: true },
  { name: config.RESOLVED_TAG_NAME, moderated: false },
];

/** Applied to new support posts until they're linked to an issue or closed. */
const OPEN_TAG = { name: config.OPEN_TAG_NAME, moderated: true };

export async function handleSetupCommand(interaction: ChatInputCommandInteraction<"cached">) {
  const group = interaction.options.getSubcommandGroup();
  const subcommand = interaction.options.getSubcommand();

  if (group === "forum" && subcommand === "add") return addForum(interaction);
  if (group === "forum" && subcommand === "remove") return removeForum(interaction);
  if (group === "forum" && subcommand === "details") return editDetailQuestions(interaction);
  if (group === "staff" && subcommand === "add") return addStaffRole(interaction);
  if (group === "staff" && subcommand === "remove") return removeStaffRole(interaction);
  if (group === "alerts" && subcommand === "on") return enableAlerts(interaction);
  if (group === "alerts" && subcommand === "off") return disableAlerts(interaction);
  if (group === "autoclose" && subcommand === "on") return enableAutoClose(interaction);
  if (group === "autoclose" && subcommand === "off") return disableAutoClose(interaction);
  if (subcommand === "show") return showConfig(interaction);
}

async function resolveForum(interaction: ChatInputCommandInteraction<"cached">) {
  const option = interaction.options.getChannel("channel", true, [ChannelType.GuildForum]);
  const channel = await interaction.guild.channels.fetch(option.id);
  if (channel?.type !== ChannelType.GuildForum) throw new SyncError("That channel isn't a forum.");
  return channel;
}

async function addForum(interaction: ChatInputCommandInteraction<"cached">) {
  const forum = await resolveForum(interaction);
  const kind = interaction.options.getString("type", true) as IssueKind;
  const createTags = interaction.options.getBoolean("create_tags") ?? true;
  const repoOption = interaction.options
    .getString("repo")
    ?.trim()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\/$/, "");

  if (repoOption !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repoOption)) {
    throw new SyncError("`repo` should look like `owner/repo`.");
  }
  if (!repoOption && !forums.get(forum.id)?.repo && !defaultRepo) {
    throw new SyncError("There's no default GitHub repo, so pass `repo` (as `owner/repo`) for this forum.");
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let repo: string | null = null;
  if (repoOption) {
    repo = await getRepository(repoOption);
    if (!repo) {
      throw new SyncError(`I can't find **${repoOption}**. Check the name, and that the bot's GitHub token can access it.`);
    }
  }
  forums.set({ channelId: forum.id, guildId: interaction.guildId, kind, repo });
  const effectiveRepo = forums.get(forum.id)?.repo ?? defaultRepo;

  const notes: string[] = [];

  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
  const permissions = forum.permissionsFor(me);
  const missing = Object.entries(REQUIRED_PERMISSIONS)
    .filter(([, flag]) => !permissions.has(flag))
    .map(([name]) => name);
  if (missing.length) {
    notes.push(`⚠️ I'm missing these permissions in ${forum}: **${missing.join(", ")}**.`);
  }

  const missingTags = (kind === "support" ? [...BOT_TAGS, OPEN_TAG] : BOT_TAGS).filter(
    ({ name }) => !forum.availableTags.some((tag) => tag.name.toLowerCase() === name.toLowerCase()),
  );
  if (missingTags.length) notes.push(await addTags(forum, missingTags, createTags));

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(missing.length ? Colors.muted : Colors.success)
        .setTitle("Forum registered")
        .setDescription(
          [
            `New posts in ${forum} will be handled as **${KIND_LABEL[kind]}s**, tracked in **${effectiveRepo}**.`,
            ...notes,
          ].join("\n\n"),
        ),
    ],
  });
}

async function addTags(forum: ForumChannel, tags: typeof BOT_TAGS, create: boolean) {
  const list = tags.map(({ name }) => `\`${name}\``).join(", ");
  if (!create) return `ℹ️ Tags ${list} don't exist in this forum, so they won't be applied.`;

  if (forum.availableTags.length + tags.length > MAX_FORUM_TAGS) {
    return `⚠️ Couldn't add tags ${list}: this forum already has the maximum of ${MAX_FORUM_TAGS} tags.`;
  }

  try {
    await forum.setAvailableTags([...forum.availableTags, ...tags]);
    return `🏷️ Created tags ${list}.`;
  } catch {
    return `⚠️ Couldn't create tags ${list}. Give me **Manage Channels** or create them yourself.`;
  }
}

async function removeForum(interaction: ChatInputCommandInteraction<"cached">) {
  const option = interaction.options.getChannel("channel", true, [ChannelType.GuildForum]);
  if (!forums.remove(option.id)) throw new SyncError(`<#${option.id}> isn't a registered forum.`);

  await interaction.reply({
    content: `<#${option.id}> is no longer managed. Existing GitHub links in it keep syncing.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function editDetailQuestions(interaction: ChatInputCommandInteraction<"cached">) {
  const option = interaction.options.getChannel("channel", true, [ChannelType.GuildForum]);
  const forum = forums.get(option.id);
  if (!forum) throw new SyncError(`<#${option.id}> isn't a registered forum. Add it with \`/setup forum add\` first.`);

  if (interaction.options.getBoolean("reset")) {
    forums.setDetailQuestions(forum.channelId, null);
    await interaction.reply({
      content: `${option} is back to the default questions.\n${questionList(DEFAULT_DETAIL_QUESTIONS[forum.kind])}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const current = detailQuestions(forum.channelId);
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(`${ComponentIds.setupDetails}${forum.channelId}`)
      .setTitle(`Questions for #${option.name}`.slice(0, 45))
      .addLabelComponents(
        Array.from({ length: MAX_DETAIL_QUESTIONS }, (_, index) => {
          const input = new TextInputBuilder()
            .setCustomId(`question-${index}`)
            .setStyle(TextInputStyle.Short)
            .setMaxLength(MAX_QUESTION_LENGTH)
            .setRequired(false);
          if (current[index]) input.setValue(current[index]);
          const label = new LabelBuilder().setLabel(`Question ${index + 1}`).setTextInputComponent(input);
          return index === 0 ? label.setDescription("Leave every question empty to stop asking for details.") : label;
        }),
      ),
  );
}

/** The submitted `/setup forum details` form. */
export async function handleDetailQuestionsModal(interaction: ModalSubmitInteraction<"cached">) {
  // Modal submissions skip the command's default permissions, so check again.
  if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
    throw new SyncError("You need Manage Server to change this.");
  }
  const forumId = interaction.customId.slice(ComponentIds.setupDetails.length);
  if (!forums.get(forumId)) throw new SyncError("That forum isn't registered anymore.");

  const questions = Array.from({ length: MAX_DETAIL_QUESTIONS }, (_, index) =>
    interaction.fields.getTextInputValue(`question-${index}`).trim(),
  ).filter(Boolean);
  forums.setDetailQuestions(forumId, questions);

  await interaction.reply({
    content: questions.length
      ? `Short new posts in <#${forumId}> will be asked:\n${questionList(questions)}`
      : `Posts in <#${forumId}> will no longer be asked for details.`,
    flags: MessageFlags.Ephemeral,
  });
}

function questionList(questions: string[]) {
  if (!questions.length) return "-# No questions, so posts aren't asked for details.";
  return questions.map((question) => `- ${question}`).join("\n");
}

async function addStaffRole(interaction: ChatInputCommandInteraction<"cached">) {
  const role = interaction.options.getRole("role", true);
  if (role.id === interaction.guildId) throw new SyncError("@everyone can't be a staff role.");
  if (role.managed) throw new SyncError(`${role} is managed by an integration and can't be a staff role.`);

  const added = staffRoles.add(interaction.guildId, role.id);
  await interaction.reply({
    content: added
      ? `${role} is now support staff. Members with it can manage GitHub issues and resolve any post.`
      : `${role} is already support staff.`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function removeStaffRole(interaction: ChatInputCommandInteraction<"cached">) {
  const role = interaction.options.getRole("role", true);
  if (!staffRoles.remove(role.id)) throw new SyncError(`${role} isn't a staff role.`);

  await interaction.reply({
    content: `${role} is no longer support staff.`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function showConfig(interaction: ChatInputCommandInteraction<"cached">) {
  const forumLines = forums
    .list(interaction.guildId)
    .map((forum) => {
      const questions = detailQuestions(forum.channelId).length;
      const details = questions ? `asks short posts ${questions} question${questions === 1 ? "" : "s"}` : "doesn't ask for details";
      return `<#${forum.channelId}> → ${KIND_LABEL[forum.kind]}s in ${forum.repo ?? defaultRepo ?? "⚠️ no repo"}, ${details}`;
    });
  const roleLines = staffRoles.list(interaction.guildId).map((id) => `<@&${id}>`);
  const settings = guildSettings.get(interaction.guildId);
  const alerts =
    settings?.alertChannelId && settings.alertAfterMins
      ? `<#${settings.alertChannelId}> after ${formatDuration(settings.alertAfterMins * 60_000)} without a staff reply` +
        (settings.alertRoleId ? `, pinging <@&${settings.alertRoleId}>` : "")
      : "Off. Use `/setup alerts on`.";
  const autoClose = settings?.autoCloseAfterMins
    ? `Support posts close after ${formatDuration(settings.autoCloseAfterMins * 60_000)} without a reply from the author`
    : "Off. Use `/setup autoclose on`.";

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.brand)
        .setTitle("Support bot configuration")
        .addFields(
          {
            name: "Forums",
            value: forumLines.join("\n") || "None yet. Use `/setup forum add`.",
          },
          {
            name: "Staff roles",
            value:
              (roleLines.join("\n") || "None yet. Use `/setup staff add`.") +
              "\n-# Members with Manage Threads are always staff.",
          },
          {
            name: "Default GitHub repository",
            value: defaultRepo
              ? `[${defaultRepo}](https://github.com/${defaultRepo})`
              : "None. Each forum needs its own `repo`.",
          },
          { name: "Unanswered alerts", value: alerts },
          { name: "Inactive posts", value: autoClose },
        ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function enableAlerts(interaction: ChatInputCommandInteraction<"cached">) {
  const channel = interaction.options.getChannel("channel", true, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
  const hours = interaction.options.getNumber("after_hours", true);
  const role = interaction.options.getRole("role");
  const minutes = Math.round(hours * 60);

  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
  const permissions = channel.permissionsFor(me);
  if (!permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    throw new SyncError(`I need **View Channel**, **Send Messages** and **Embed Links** in ${channel}.`);
  }

  guildSettings.setAlerts(interaction.guildId, channel.id, role?.id ?? null, minutes);
  await interaction.reply({
    content:
      `I'll post in ${channel} when a post has had no staff reply for **${formatDuration(minutes * 60_000)}**` +
      (role ? `, pinging ${role}.` : ".") +
      "\n-# Only posts from the last week that were created while the bot was running are checked.",
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function disableAlerts(interaction: ChatInputCommandInteraction<"cached">) {
  guildSettings.setAlerts(interaction.guildId, null, null, null);
  await interaction.reply({ content: "Unanswered-post alerts are off.", flags: MessageFlags.Ephemeral });
}

async function enableAutoClose(interaction: ChatInputCommandInteraction<"cached">) {
  const minutes = Math.round(interaction.options.getNumber("after_days", true) * 24 * 60);
  guildSettings.setAutoClose(interaction.guildId, minutes);
  await interaction.reply({
    content:
      `Support posts will close when staff replied last and the author hasn't answered for ` +
      `**${formatDuration(minutes * 60_000)}**. The closing message has a **Reactivate** button.\n` +
      "-# Posts linked to a GitHub issue are left alone.",
    flags: MessageFlags.Ephemeral,
  });
}

async function disableAutoClose(interaction: ChatInputCommandInteraction<"cached">) {
  guildSettings.setAutoClose(interaction.guildId, null);
  await interaction.reply({ content: "Inactive posts will no longer be closed.", flags: MessageFlags.Ephemeral });
}
