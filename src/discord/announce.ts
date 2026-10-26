import { extname } from "node:path";
import {
  ChannelType,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type Attachment,
  type ChatInputCommandInteraction,
  type Embed,
  type Message,
  type MessageCreateOptions,
  type MessageEditOptions,
  type ModalSubmitInteraction,
  type NewsChannel,
  type Role,
  type TextChannel,
} from "discord.js";
import { announcements } from "../db.js";
import { SyncError } from "../sync.js";
import { Colors, ComponentIds, isStaff } from "./util.js";

export const ANNOUNCE_COLORS = {
  brand: Colors.brand,
  green: Colors.success,
  purple: Colors.merged,
  gray: Colors.muted,
  yellow: Colors.warning,
  red: Colors.danger,
} as const;

const Fields = {
  title: "title",
  message: "message",
  url: "url",
  footer: "footer",
} as const;

type AnnounceChannel = TextChannel | NewsChannel;

/** Slash command options waiting for the modal to be submitted, keyed by the command's interaction ID. */
type PendingAnnouncement =
  | { mode: "post"; channel: AnnounceChannel; color: number; image: Attachment | null; ping: Role | null; publish: boolean }
  | { mode: "edit"; message: Message<true>; color: number | null; image: Attachment | null; removeImage: boolean };

const pending = new Map<string, PendingAnnouncement>();
/** Discord stops accepting a modal's submission after 15 minutes. */
const PENDING_TTL_MS = 15 * 60 * 1000;

function remember(id: string, options: PendingAnnouncement) {
  pending.set(id, options);
  setTimeout(() => pending.delete(id), PENDING_TTL_MS).unref();
}

/** `/announce post` and `/announce edit`: check the options, then open a form for the text. */
export async function handleAnnounceCommand(interaction: ChatInputCommandInteraction<"cached">) {
  if (!isStaff(interaction)) throw new SyncError("Only staff can post announcements.");
  if (interaction.options.getSubcommand() === "edit") return startEdit(interaction);

  const channel =
    interaction.options.getChannel("channel", false, [ChannelType.GuildText, ChannelType.GuildAnnouncement]) ??
    interaction.channel;
  if (channel?.type !== ChannelType.GuildText && channel?.type !== ChannelType.GuildAnnouncement) {
    throw new SyncError("Pick a text or announcement channel with the `channel` option.");
  }

  const image = imageOption(interaction);
  const ping = interaction.options.getRole("ping");
  const publish = interaction.options.getBoolean("publish") ?? false;
  if (publish && channel.type !== ChannelType.GuildAnnouncement) {
    throw new SyncError("`publish` only works in announcement channels.");
  }

  checkPermissions(interaction, channel, { image: Boolean(image), ping });

  const color = colorOption(interaction) ?? Colors.brand;
  remember(interaction.id, { mode: "post", channel, color, image, ping, publish });
  await interaction.showModal(announceModal(interaction.id, `Announce in #${channel.name}`));
}

async function startEdit(interaction: ChatInputCommandInteraction<"cached">) {
  // Accepts a message link or a bare message ID; either way the ID is the last number in it.
  const messageId = interaction.options.getString("message", true).match(/(\d{17,20})\D*$/)?.[1];
  const record = messageId ? announcements.get(messageId) : undefined;
  if (!record || record.guildId !== interaction.guildId) {
    throw new SyncError("That isn't an announcement posted with `/announce` in this server. Paste its message link.");
  }

  const channel = interaction.guild.channels.cache.get(record.channelId);
  if (channel?.type !== ChannelType.GuildText && channel?.type !== ChannelType.GuildAnnouncement) {
    announcements.remove(record.messageId);
    throw new SyncError("The channel that announcement was in no longer exists.");
  }
  const message = await channel.messages.fetch(record.messageId).catch(() => null);
  const [embed] = message?.embeds ?? [];
  if (!message || !embed) {
    announcements.remove(record.messageId);
    throw new SyncError("That announcement was deleted.");
  }

  const image = imageOption(interaction);
  const removeImage = interaction.options.getBoolean("remove_image") ?? false;
  if (image && removeImage) throw new SyncError("Pass either `image` or `remove_image`, not both.");

  checkPermissions(interaction, channel, { image: Boolean(image), ping: null });

  remember(interaction.id, { mode: "edit", message, color: colorOption(interaction), image, removeImage });
  await interaction.showModal(announceModal(interaction.id, `Edit announcement in #${channel.name}`, embed));
}

function colorOption(interaction: ChatInputCommandInteraction<"cached">) {
  const color = interaction.options.getString("color") as keyof typeof ANNOUNCE_COLORS | null;
  return color ? ANNOUNCE_COLORS[color] : null;
}

function imageOption(interaction: ChatInputCommandInteraction<"cached">) {
  const image = interaction.options.getAttachment("image");
  if (image && !image.contentType?.startsWith("image/")) throw new SyncError("`image` must be an image file.");
  return image;
}

/** Makes sure both the bot and the staff member are allowed to do everything the announcement needs. */
function checkPermissions(
  interaction: ChatInputCommandInteraction<"cached">,
  channel: AnnounceChannel,
  { image, ping }: { image: boolean; ping: Role | null },
) {
  const member = channel.permissionsFor(interaction.member);
  if (!member.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    throw new SyncError(`You can't send messages in ${channel}.`);
  }
  // Same rule Discord applies to people: unmentionable roles and @everyone need Mention Everyone.
  if (ping && (ping.id === interaction.guildId || !ping.mentionable) && !member.has(PermissionFlagsBits.MentionEveryone)) {
    throw new SyncError(`You don't have permission to ping ${pingText(ping)} in ${channel}.`);
  }

  const bot = channel.permissionsFor(interaction.guild.members.me ?? interaction.client.user);
  const needed = {
    "View Channel": PermissionFlagsBits.ViewChannel,
    "Send Messages": PermissionFlagsBits.SendMessages,
    "Embed Links": PermissionFlagsBits.EmbedLinks,
    ...(image ? { "Attach Files": PermissionFlagsBits.AttachFiles } : {}),
    ...(ping && !ping.mentionable ? { "Mention Everyone": PermissionFlagsBits.MentionEveryone } : {}),
  };
  const missing = Object.entries(needed).filter(([, flag]) => !bot?.has(flag));
  if (missing.length) {
    throw new SyncError(`I'm missing these permissions in ${channel}: ${missing.map(([name]) => name).join(", ")}.`);
  }
}

/** The form for an announcement's text, filled in from `current` when editing. */
function announceModal(id: string, title: string, current?: Embed) {
  const input = (customId: string, style: TextInputStyle, maxLength: number, required: boolean, value?: string | null) => {
    const builder = new TextInputBuilder()
      .setCustomId(customId)
      .setStyle(style)
      .setMaxLength(maxLength)
      .setRequired(required);
    if (value) builder.setValue(value.slice(0, maxLength));
    return builder;
  };

  return new ModalBuilder()
    .setCustomId(`${ComponentIds.announce}${id}`)
    .setTitle(title.slice(0, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Title")
        .setTextInputComponent(input(Fields.title, TextInputStyle.Short, 256, true, current?.title)),
      new LabelBuilder()
        .setLabel("Message")
        .setDescription("Supports Discord markdown: **bold**, lists, [links](https://example.com), etc.")
        .setTextInputComponent(input(Fields.message, TextInputStyle.Paragraph, 4000, true, current?.description)),
      new LabelBuilder()
        .setLabel("Link")
        .setDescription("Optional. Makes the title a link.")
        .setTextInputComponent(
          input(Fields.url, TextInputStyle.Short, 512, false, current?.url).setPlaceholder("https://"),
        ),
      new LabelBuilder()
        .setLabel("Footer")
        .setDescription("Optional small text at the bottom.")
        .setTextInputComponent(input(Fields.footer, TextInputStyle.Short, 2048, false, current?.footer?.text)),
    );
}

/** The submitted announcement form. */
export async function handleAnnounceModal(interaction: ModalSubmitInteraction<"cached">) {
  const id = interaction.customId.slice(ComponentIds.announce.length);
  const options = pending.get(id);
  if (!options) throw new SyncError("This form expired (or the bot restarted). Run `/announce` again.");

  const url = interaction.fields.getTextInputValue(Fields.url).trim();
  if (url && !/^https?:\/\/\S+$/.test(url)) throw new SyncError("The link must start with `http://` or `https://`.");
  pending.delete(id);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const embed = new EmbedBuilder()
    .setTitle(interaction.fields.getTextInputValue(Fields.title).trim())
    .setDescription(interaction.fields.getTextInputValue(Fields.message).trim())
    .setAuthor({ name: interaction.guild.name, iconURL: interaction.guild.iconURL() ?? undefined });
  if (url) embed.setURL(url);
  const footer = interaction.fields.getTextInputValue(Fields.footer).trim();
  if (footer) embed.setFooter({ text: footer });

  if (options.mode === "edit") return editAnnouncement(interaction, embed, options);

  embed.setColor(options.color).setTimestamp();
  const message: MessageCreateOptions = { embeds: [embed], allowedMentions: { parse: [] } };
  if (options.image) message.files = [attachImage(embed, options.image)];
  if (options.ping) {
    message.content = pingText(options.ping);
    message.allowedMentions =
      options.ping.id === interaction.guildId ? { parse: ["everyone"] } : { roles: [options.ping.id] };
  }

  const sent = await options.channel.send(message);
  announcements.add({
    messageId: sent.id,
    guildId: interaction.guildId,
    channelId: sent.channelId,
    createdBy: interaction.user.id,
  });

  let published = "";
  if (options.publish) {
    published = await sent.crosspost().then(
      () => " and published it to following servers",
      (error) => {
        console.warn("Failed to publish announcement:", error);
        return ", but couldn't publish it to following servers";
      },
    );
  }

  await interaction.editReply({ content: `Posted the announcement in ${options.channel}${published}: ${sent.url}` });
}

async function editAnnouncement(
  interaction: ModalSubmitInteraction<"cached">,
  embed: EmbedBuilder,
  options: Extract<PendingAnnouncement, { mode: "edit" }>,
) {
  const { message } = options;
  const [current] = message.embeds;
  // Keep the original color and posting time unless a new color was picked.
  embed.setColor(options.color ?? current?.color ?? Colors.brand);
  if (current?.timestamp) embed.setTimestamp(new Date(current.timestamp));

  const edit: MessageEditOptions = { embeds: [embed], allowedMentions: { parse: [] } };
  if (options.image) {
    edit.files = [attachImage(embed, options.image)];
    edit.attachments = [];
  } else if (options.removeImage) {
    edit.attachments = [];
  } else {
    const [image] = message.attachments.values();
    if (image) embed.setImage(`attachment://${image.name}`);
  }

  const edited = await message.edit(edit).catch((error) => {
    console.warn("Failed to edit announcement:", error);
    throw new SyncError("Couldn't edit that announcement. It may have been deleted.");
  });
  // Edits to a published message reach following servers on their own.
  await interaction.editReply({ content: `Updated the announcement: ${edited.url}` });
}

/** Re-uploads the image with the message: the CDN link of a slash command attachment expires. */
function attachImage(embed: EmbedBuilder, image: Attachment) {
  const name = `announcement${extname(image.name).toLowerCase() || ".png"}`;
  embed.setImage(`attachment://${name}`);
  return { attachment: image.url, name };
}

function pingText(role: Role) {
  return role.id === role.guild.id ? "@everyone" : role.toString();
}
