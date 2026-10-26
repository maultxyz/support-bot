import { extname } from "node:path";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  CheckboxBuilder,
  EmbedBuilder,
  FileUploadBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type APIEmbed,
  type Attachment,
  type AttachmentPayload,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Embed,
  type GuildMember,
  type Message,
  type ModalSubmitInteraction,
  type NewsChannel,
  type Role,
  type StringSelectMenuInteraction,
  type TextChannel,
} from "discord.js";
import { announcements } from "../db.js";
import { SyncError } from "../sync.js";
import { Colors, ComponentIds, isStaff, truncate } from "./util.js";

const COLOR_CHOICES = [
  { label: "Blurple", value: Colors.brand, emoji: "🟦" },
  { label: "Green", value: Colors.success, emoji: "🟩" },
  { label: "Purple", value: Colors.merged, emoji: "🟪" },
  { label: "Yellow", value: Colors.warning, emoji: "🟨" },
  { label: "Red", value: Colors.danger, emoji: "🟥" },
  { label: "Gray", value: Colors.muted, emoji: "⬜" },
];

/** What each builder button, menu and form does; part of their custom IDs. */
const Actions = {
  text: "text",
  footer: "footer",
  author: "author",
  images: "images",
  addField: "add-field",
  /** Select menu that opens the form for one field. */
  pickField: "pick-field",
  /** Form for one field; followed by `:<index>` or `:new`. */
  field: "field",
  color: "color",
  customColor: "custom-color",
  post: "post",
  cancel: "cancel",
} as const;

const MAX_FIELDS = 25;
const MAX_EMBED_LENGTH = 6000;
/** Drafts are dropped after this long without changes. */
const DRAFT_TTL_MS = 60 * 60 * 1000;

type AnnounceChannel = TextChannel | NewsChannel;

interface Draft {
  id: string;
  ownerId: string;
  target:
    | { mode: "post"; channel: AnnounceChannel; ping: Role | null; publish: boolean }
    | { mode: "edit"; message: Message<true> };
  embed: APIEmbed;
  timestamp: boolean;
  /** Images uploaded through the builder, keyed by `urlKey`. They're re-uploaded with the message. */
  uploads: Map<string, Attachment>;
  expiry: NodeJS.Timeout;
}

const drafts = new Map<string, Draft>();

function saveDraft(draft: Omit<Draft, "expiry">) {
  const expiry = setTimeout(() => drafts.delete(draft.id), DRAFT_TTL_MS).unref();
  drafts.set(draft.id, { ...draft, expiry });
}

function touch(draft: Draft) {
  draft.expiry.refresh();
}

/** `/announce post` and `/announce edit`: open a builder (only visible to the staff member) with a live preview. */
export async function handleAnnounceCommand(interaction: ChatInputCommandInteraction<"cached">) {
  if (!isStaff(interaction)) throw new SyncError("Only staff can post announcements.");

  if (interaction.options.getSubcommand() === "edit") {
    const message = await findAnnouncement(interaction);
    checkPermissions(interaction.member, message.channel as AnnounceChannel, { files: false, ping: null });
    saveDraft({
      id: interaction.id,
      ownerId: interaction.user.id,
      target: { mode: "edit", message },
      embed: editableEmbed(message.embeds[0]!),
      timestamp: Boolean(message.embeds[0]!.timestamp),
      uploads: new Map(),
    });
  } else {
    const channel =
      interaction.options.getChannel("channel", false, [ChannelType.GuildText, ChannelType.GuildAnnouncement]) ??
      interaction.channel;
    if (channel?.type !== ChannelType.GuildText && channel?.type !== ChannelType.GuildAnnouncement) {
      throw new SyncError("Pick a text or announcement channel with the `channel` option.");
    }
    const ping = interaction.options.getRole("ping");
    const publish = interaction.options.getBoolean("publish") ?? false;
    if (publish && channel.type !== ChannelType.GuildAnnouncement) {
      throw new SyncError("`publish` only works in announcement channels.");
    }
    checkPermissions(interaction.member, channel, { files: false, ping });
    saveDraft({
      id: interaction.id,
      ownerId: interaction.user.id,
      target: { mode: "post", channel, ping, publish },
      embed: {
        color: Colors.brand,
        author: { name: interaction.guild.name, icon_url: interaction.guild.iconURL() ?? undefined },
      },
      timestamp: true,
      uploads: new Map(),
    });
  }

  await interaction.reply({ ...renderBuilder(drafts.get(interaction.id)!), flags: MessageFlags.Ephemeral });
}

async function findAnnouncement(interaction: ChatInputCommandInteraction<"cached">) {
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
  if (!message?.embeds[0]) {
    announcements.remove(record.messageId);
    throw new SyncError("That announcement was deleted.");
  }
  return message;
}

/** Only the parts of an embed the builder knows about, so read-only data from Discord isn't sent back. */
function editableEmbed(embed: Embed): APIEmbed {
  const { title, description, url, color, author, footer, fields, image, thumbnail } = embed.data;
  return {
    title,
    description,
    url,
    color,
    author: author && { name: author.name, url: author.url, icon_url: author.icon_url },
    footer: footer && { text: footer.text, icon_url: footer.icon_url },
    fields: fields?.map(({ name, value, inline }) => ({ name, value, inline })),
    image: image && { url: image.url },
    thumbnail: thumbnail && { url: thumbnail.url },
  };
}

/** Makes sure both the bot and the staff member are allowed to do everything the announcement needs. */
function checkPermissions(
  member: GuildMember,
  channel: AnnounceChannel,
  { files, ping }: { files: boolean; ping: Role | null },
) {
  const own = channel.permissionsFor(member);
  if (!own.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    throw new SyncError(`You can't send messages in ${channel}.`);
  }
  // Same rule Discord applies to people: unmentionable roles and @everyone need Mention Everyone.
  if (ping && (ping.id === channel.guildId || !ping.mentionable) && !own.has(PermissionFlagsBits.MentionEveryone)) {
    throw new SyncError(`You don't have permission to ping ${pingText(ping)} in ${channel}.`);
  }

  const bot = channel.guild.members.me && channel.permissionsFor(channel.guild.members.me);
  const needed = {
    "View Channel": PermissionFlagsBits.ViewChannel,
    "Send Messages": PermissionFlagsBits.SendMessages,
    "Embed Links": PermissionFlagsBits.EmbedLinks,
    ...(files ? { "Attach Files": PermissionFlagsBits.AttachFiles } : {}),
    ...(ping && !ping.mentionable ? { "Mention Everyone": PermissionFlagsBits.MentionEveryone } : {}),
  };
  const missing = Object.entries(needed).filter(([, flag]) => !bot?.has(flag));
  if (missing.length) {
    throw new SyncError(`I'm missing these permissions in ${channel}: ${missing.map(([name]) => name).join(", ")}.`);
  }
}

function customId(draft: Draft, action: string, extra?: string) {
  return [`${ComponentIds.announce}${action}`, draft.id, extra].filter(Boolean).join(":");
}

function hasContent(embed: APIEmbed) {
  return Boolean(embed.title || embed.description);
}

/** The builder message: a preview of the announcement and the controls for changing it. */
function renderBuilder(draft: Draft) {
  const { target, embed } = draft;
  const header =
    target.mode === "post"
      ? [
          `**Announcement draft** for ${target.channel}`,
          target.ping && `pings ${pingText(target.ping)}`,
          target.publish && "publishes to following servers",
        ]
          .filter(Boolean)
          .join(" · ")
      : `**Editing** ${target.message.url}`;

  const preview = hasContent(embed)
    ? new EmbedBuilder({ ...embed, timestamp: draft.timestamp ? timestampFor(draft) : undefined })
    : new EmbedBuilder()
        .setColor(Colors.muted)
        .setDescription("*Nothing here yet. Press **Title & message** to start writing.*");

  // One button per part of the embed, in the order they appear in it from top to bottom.
  const edit = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(customId(draft, Actions.author)).setLabel("Author").setEmoji("👤").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(customId(draft, Actions.text))
      .setLabel("Title & message")
      .setEmoji("✏️")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(customId(draft, Actions.addField))
      .setLabel("Add field")
      .setEmoji("➕")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled((embed.fields?.length ?? 0) >= MAX_FIELDS),
    new ButtonBuilder().setCustomId(customId(draft, Actions.images)).setLabel("Images").setEmoji("🖼️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(customId(draft, Actions.footer)).setLabel("Footer").setEmoji("🔻").setStyle(ButtonStyle.Secondary),
  );

  const color = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId(draft, Actions.color))
      .setPlaceholder("Color")
      .addOptions(
        ...COLOR_CHOICES.map((choice) => ({
          label: choice.label,
          value: String(choice.value),
          emoji: choice.emoji,
          default: choice.value === embed.color,
        })),
        { label: "Custom color…", value: Actions.customColor, emoji: "🎨", description: hexColor(embed.color) },
      ),
  );

  const fields = embed.fields?.length
    ? [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(customId(draft, Actions.pickField))
            .setPlaceholder("Edit or remove a field…")
            .addOptions(
              embed.fields.map((field, index) => ({
                label: truncate(field.name, 100),
                description: truncate(field.value, 100),
                value: String(index),
              })),
            ),
        ),
      ]
    : [];

  const finish = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(customId(draft, Actions.post))
      .setLabel(target.mode === "post" ? "Post" : "Save changes")
      .setEmoji(target.mode === "post" ? "📣" : "💾")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!hasContent(embed)),
    new ButtonBuilder().setCustomId(customId(draft, Actions.cancel)).setLabel("Discard").setStyle(ButtonStyle.Danger),
  );

  return {
    content:
      `${header}\n-# Only you can see this. The buttons edit the embed's parts from top to bottom: ` +
      "author, title & message, fields, images, footer.",
    embeds: [preview],
    components: [edit, color, ...fields, finish],
    allowedMentions: { parse: [] },
  };
}

function timestampFor(draft: Draft) {
  // An edited announcement keeps the time it was first posted.
  const original = draft.target.mode === "edit" ? draft.target.message.embeds[0]?.timestamp : null;
  return original ?? new Date().toISOString();
}

function hexColor(color: number | undefined) {
  return `#${(color ?? 0).toString(16).padStart(6, "0")}`;
}

function getDraft(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction) {
  const [, draftId] = interaction.customId.slice(ComponentIds.announce.length).split(":");
  const draft = drafts.get(draftId ?? "");
  if (!draft) throw new SyncError("This draft expired (or the bot restarted). Run `/announce` again.");
  if (draft.ownerId !== interaction.user.id) throw new SyncError("This isn't your draft.");
  touch(draft);
  return draft;
}

/** Buttons and menus on the builder message. */
export async function handleAnnounceComponent(
  interaction: ButtonInteraction<"cached"> | StringSelectMenuInteraction<"cached">,
) {
  const draft = getDraft(interaction);
  const [action] = interaction.customId.slice(ComponentIds.announce.length).split(":");
  const { embed } = draft;

  switch (action) {
    case Actions.text:
      return interaction.showModal(textModal(draft));
    case Actions.footer:
      return interaction.showModal(footerModal(draft));
    case Actions.author:
      return interaction.showModal(authorModal(draft));
    case Actions.images:
      return interaction.showModal(imagesModal(draft));
    case Actions.addField:
      return interaction.showModal(fieldModal(draft, null));
    case Actions.pickField: {
      if (!interaction.isStringSelectMenu()) return;
      const index = Number(interaction.values[0]);
      if (!embed.fields?.[index]) throw new SyncError("That field no longer exists.");
      return interaction.showModal(fieldModal(draft, index));
    }
    case Actions.color: {
      if (!interaction.isStringSelectMenu()) return;
      const [value] = interaction.values;
      if (value === Actions.customColor) return interaction.showModal(customColorModal(draft));
      embed.color = Number(value);
      return interaction.update(renderBuilder(draft));
    }
    case Actions.post:
      if (interaction.isButton()) return postDraft(interaction, draft);
      return;
    case Actions.cancel:
      clearTimeout(draft.expiry);
      drafts.delete(draft.id);
      return interaction.update({ content: "Discarded the draft.", embeds: [], components: [] });
  }
}

function textInput(customId: string, style: TextInputStyle, maxLength: number, value?: string | null) {
  const input = new TextInputBuilder().setCustomId(customId).setStyle(style).setMaxLength(maxLength).setRequired(false);
  if (value) input.setValue(value.slice(0, maxLength));
  return input;
}

function label(text: string, description?: string) {
  const builder = new LabelBuilder().setLabel(text);
  return description ? builder.setDescription(description) : builder;
}

function textModal(draft: Draft) {
  const { embed } = draft;
  return new ModalBuilder()
    .setCustomId(customId(draft, Actions.text))
    .setTitle("Title & message")
    .addLabelComponents(
      label("Title", "Bold heading at the top of the announcement.").setTextInputComponent(
        textInput("title", TextInputStyle.Short, 256, embed.title),
      ),
      label("Title link", "Optional. Makes the title a link.").setTextInputComponent(
        textInput("url", TextInputStyle.Short, 512, embed.url).setPlaceholder("https://"),
      ),
      label("Message", "The main text under the title. Supports markdown: **bold**, lists, [links](https://…).").setTextInputComponent(
        textInput("description", TextInputStyle.Paragraph, 4000, embed.description),
      ),
    );
}

function footerModal(draft: Draft) {
  const { footer } = draft.embed;
  return new ModalBuilder()
    .setCustomId(customId(draft, Actions.footer))
    .setTitle("Footer")
    .addLabelComponents(
      label("Footer text", "Small text on the last line. Clear it to remove it.").setTextInputComponent(
        textInput("text", TextInputStyle.Short, 2048, footer?.text),
      ),
      label("Footer icon link", "Optional. Link to a small round image before the footer text.").setTextInputComponent(
        textInput("icon", TextInputStyle.Short, 2000, footer?.icon_url).setPlaceholder("https://"),
      ),
      label("Show posting time", "Shown on the footer line, in each reader's own time zone.").setCheckboxComponent(
        new CheckboxBuilder().setCustomId("timestamp").setDefault(draft.timestamp),
      ),
    );
}

function authorModal(draft: Draft) {
  const { author } = draft.embed;
  return new ModalBuilder()
    .setCustomId(customId(draft, Actions.author))
    .setTitle("Author")
    .addLabelComponents(
      label("Name", "Small line above the title. Clear it to remove the author.").setTextInputComponent(
        textInput("name", TextInputStyle.Short, 256, author?.name),
      ),
      label("Icon link", "Optional. Link to a small round image next to the name.").setTextInputComponent(
        textInput("icon", TextInputStyle.Short, 2000, author?.icon_url).setPlaceholder("https://"),
      ),
      label("Name link", "Optional. Makes the name a link.").setTextInputComponent(
        textInput("url", TextInputStyle.Short, 512, author?.url).setPlaceholder("https://"),
      ),
    );
}

function imagesModal(draft: Draft) {
  const { embed } = draft;
  const upload = (id: string) => new FileUploadBuilder().setCustomId(id).setRequired(false).setMaxValues(1);
  return new ModalBuilder()
    .setCustomId(customId(draft, Actions.images))
    .setTitle("Images")
    .addLabelComponents(
      label("Image", "Large image under the message. Upload one, or use the link below.").setFileUploadComponent(
        upload("image-file"),
      ),
      label("Image link", "Clear it to remove the image.").setTextInputComponent(
        textInput("image-url", TextInputStyle.Short, 2000, embed.image?.url).setPlaceholder("https://"),
      ),
      label("Thumbnail", "Small image in the top right. Upload one, or use the link below.").setFileUploadComponent(
        upload("thumbnail-file"),
      ),
      label("Thumbnail link", "Clear it to remove the thumbnail.").setTextInputComponent(
        textInput("thumbnail-url", TextInputStyle.Short, 2000, embed.thumbnail?.url).setPlaceholder("https://"),
      ),
    );
}

function fieldModal(draft: Draft, index: number | null) {
  const field = index === null ? undefined : draft.embed.fields?.[index];
  const modal = new ModalBuilder()
    .setCustomId(customId(draft, Actions.field, index === null ? "new" : String(index)))
    .setTitle(field ? "Edit field" : "Add field")
    .addLabelComponents(
      label("Name").setTextInputComponent(textInput("name", TextInputStyle.Short, 256, field?.name).setRequired(true)),
      label("Value").setTextInputComponent(
        textInput("value", TextInputStyle.Paragraph, 1024, field?.value).setRequired(true),
      ),
      label("Inline", "Show next to other inline fields (up to 3 per row) instead of on its own line.").setCheckboxComponent(
        new CheckboxBuilder().setCustomId("inline").setDefault(field?.inline ?? false),
      ),
    );
  if (field) {
    modal.addLabelComponents(
      label("Remove this field").setCheckboxComponent(new CheckboxBuilder().setCustomId("remove").setDefault(false)),
    );
  }
  return modal;
}

function customColorModal(draft: Draft) {
  return new ModalBuilder()
    .setCustomId(customId(draft, Actions.customColor))
    .setTitle("Custom color")
    .addLabelComponents(
      label("Hex color", "For example #ff7a00.").setTextInputComponent(
        textInput("hex", TextInputStyle.Short, 7, hexColor(draft.embed.color)).setMinLength(6).setRequired(true),
      ),
    );
}

/** A submitted builder form. Applies the change and refreshes the preview. */
export async function handleAnnounceModal(interaction: ModalSubmitInteraction<"cached">) {
  const draft = getDraft(interaction);
  const [action, , extra] = interaction.customId.slice(ComponentIds.announce.length).split(":");
  const value = (id: string) => interaction.fields.getTextInputValue(id).trim();

  // Work on a copy so a rejected change leaves the draft as it was.
  const embed = structuredClone(draft.embed);
  const newUploads: Attachment[] = [];
  let timestamp = draft.timestamp;

  switch (action) {
    case Actions.text: {
      embed.title = value("title") || undefined;
      embed.description = value("description") || undefined;
      embed.url = optionalUrl(value("url"), "Title link");
      if (embed.url && !embed.title) throw new SyncError("A title link needs a title.");
      break;
    }
    case Actions.footer: {
      const text = value("text");
      const icon = optionalUrl(value("icon"), "Footer icon link");
      if (icon && !text) throw new SyncError("A footer icon needs footer text.");
      embed.footer = text ? { text, icon_url: icon } : undefined;
      timestamp = interaction.fields.getCheckbox("timestamp");
      break;
    }
    case Actions.author: {
      const name = value("name");
      embed.author = name
        ? { name, icon_url: optionalUrl(value("icon"), "Icon link"), url: optionalUrl(value("url"), "Name link") }
        : undefined;
      break;
    }
    case Actions.images:
      for (const slot of ["image", "thumbnail"] as const) {
        const file = interaction.fields.getUploadedFiles(`${slot}-file`)?.first();
        if (file) {
          if (!file.contentType?.startsWith("image/")) throw new SyncError(`The ${slot} must be an image file.`);
          newUploads.push(file);
          embed[slot] = { url: file.url };
        } else {
          const url = optionalUrl(value(`${slot}-url`), `${slot === "image" ? "Image" : "Thumbnail"} link`);
          embed[slot] = url ? { url } : undefined;
        }
      }
      break;
    case Actions.field: {
      const fields = (embed.fields ??= []);
      const field = { name: value("name"), value: value("value"), inline: interaction.fields.getCheckbox("inline") };
      if (extra === "new") {
        if (fields.length >= MAX_FIELDS) throw new SyncError(`An announcement can have at most ${MAX_FIELDS} fields.`);
        fields.push(field);
        break;
      }
      const index = Number(extra);
      if (!fields[index]) throw new SyncError("That field no longer exists.");
      if (interaction.fields.getCheckbox("remove")) fields.splice(index, 1);
      else fields[index] = field;
      break;
    }
    case Actions.customColor: {
      const hex = value("hex").replace(/^#/, "");
      if (!/^[0-9a-f]{6}$/i.test(hex)) throw new SyncError("Use a 6-digit hex color, like `#ff7a00`.");
      embed.color = parseInt(hex, 16);
      break;
    }
    default:
      return;
  }

  if (embedLength(embed) > MAX_EMBED_LENGTH) {
    throw new SyncError(`That would make the announcement longer than Discord's limit of ${MAX_EMBED_LENGTH} characters.`);
  }
  draft.embed = embed;
  draft.timestamp = timestamp;
  for (const file of newUploads) draft.uploads.set(urlKey(file.url), file);

  if (interaction.isFromMessage()) await interaction.update(renderBuilder(draft));
}

function optionalUrl(value: string, name: string) {
  if (!value) return undefined;
  if (!/^https?:\/\/\S+$/.test(value)) throw new SyncError(`${name} must start with \`http://\` or \`https://\`.`);
  return value;
}

function embedLength(embed: APIEmbed) {
  const parts = [
    embed.title,
    embed.description,
    embed.footer?.text,
    embed.author?.name,
    ...(embed.fields ?? []).flatMap((field) => [field.name, field.value]),
  ];
  return parts.reduce((total, part) => total + (part?.length ?? 0), 0);
}

/** Discord CDN links carry expiring query parameters, so compare them without those. */
function urlKey(url: string) {
  try {
    const { origin, pathname } = new URL(url);
    return origin + pathname;
  } catch {
    return url;
  }
}

/**
 * The embed to send, with its images pointing at attachments: new uploads are re-uploaded (their links
 * expire), and an edited announcement keeps the attachments it still uses.
 */
function finalMessage(draft: Draft) {
  const embed: APIEmbed = structuredClone(draft.embed);
  if (draft.timestamp) embed.timestamp = timestampFor(draft);
  const files: AttachmentPayload[] = [];
  const keep = new Set<Attachment>();
  const existing = draft.target.mode === "edit" ? [...draft.target.message.attachments.values()] : [];

  for (const slot of ["image", "thumbnail"] as const) {
    const url = embed[slot]?.url;
    if (!url) continue;
    const key = urlKey(url);
    const upload = draft.uploads.get(key);
    const kept = existing.find((attachment) => urlKey(attachment.url) === key);
    if (upload) {
      const name = `${slot}${extname(upload.name).toLowerCase() || ".png"}`;
      files.push({ attachment: upload.url, name });
      embed[slot] = { url: `attachment://${name}` };
    } else if (kept) {
      keep.add(kept);
      embed[slot] = { url: `attachment://${kept.name}` };
    }
  }
  return { embed, files, keep: [...keep] };
}

async function postDraft(interaction: ButtonInteraction<"cached">, draft: Draft) {
  if (!isStaff(interaction)) throw new SyncError("Only staff can post announcements.");
  if (!hasContent(draft.embed)) throw new SyncError("Add a title or message first.");

  const { target } = draft;
  const channel = target.mode === "post" ? target.channel : (target.message.channel as AnnounceChannel);
  const { embed, files, keep } = finalMessage(draft);
  checkPermissions(interaction.member, channel, {
    files: files.length > 0,
    ping: target.mode === "post" ? target.ping : null,
  });

  await interaction.deferUpdate();
  let result: string;
  try {
    result =
      target.mode === "post"
        ? await sendAnnouncement(interaction, target, embed, files)
        : await editAnnouncement(target.message, embed, files, keep);
  } catch (error) {
    // Keep the draft so nothing is lost; the staff member can try again.
    console.warn("Failed to post announcement:", error);
    await interaction.followUp({
      content: "Couldn't post the announcement. Check my permissions in that channel and try again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  clearTimeout(draft.expiry);
  drafts.delete(draft.id);
  await interaction.editReply({ content: result, embeds: [], components: [] });
}

async function sendAnnouncement(
  interaction: ButtonInteraction<"cached">,
  target: Extract<Draft["target"], { mode: "post" }>,
  embed: APIEmbed,
  files: AttachmentPayload[],
) {
  const { channel, ping, publish } = target;
  const sent = await channel.send({
    content: ping ? pingText(ping) : undefined,
    embeds: [embed],
    files,
    allowedMentions: !ping ? { parse: [] } : ping.id === channel.guildId ? { parse: ["everyone"] } : { roles: [ping.id] },
  });
  announcements.add({ messageId: sent.id, guildId: channel.guildId, channelId: channel.id, createdBy: interaction.user.id });

  let published = "";
  if (publish) {
    published = await sent.crosspost().then(
      () => " and published it to following servers",
      (error) => {
        console.warn("Failed to publish announcement:", error);
        return ", but couldn't publish it to following servers";
      },
    );
  }
  return `Posted the announcement in ${channel}${published}: ${sent.url}`;
}

async function editAnnouncement(message: Message<true>, embed: APIEmbed, files: AttachmentPayload[], keep: Attachment[]) {
  // Listing the attachments to keep drops ones the announcement no longer uses.
  const edited = await message.edit({ embeds: [embed], files, attachments: keep, allowedMentions: { parse: [] } });
  // Edits to a published message reach following servers on their own.
  return `Updated the announcement: ${edited.url}`;
}

function pingText(role: Role) {
  return role.id === role.guild.id ? "@everyone" : role.toString();
}
