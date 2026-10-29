import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { faqRelevance, faqs, type FaqEntry } from "../db.js";
import { faqEnabled } from "../faq.js";
import { SyncError } from "../sync.js";
import {
  DEFAULT_KEEP,
  entryEmbed,
  faqModal,
  generateFaq,
  markdownFile,
  mergeFaqPreview,
  publishFaq,
  saveFaqForm,
  sendFaqEntry,
} from "./faq.js";
import { Colors, ComponentIds, isStaff, truncate } from "./util.js";

/** Entries per page of the panel's menu: Discord's limit for one select menu. */
const PAGE_SIZE = 25;
/** Entries listed in the panel's "Most asked" field. */
const TOP_COUNT = 10;

const id = (action: string) => `${ComponentIds.faq}${action}`;
type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;

/**
 * `/faq`: with an entry, answers the current post with it. Without one, opens the FAQ panel, where staff do
 * everything else with buttons. Callers check that the user is staff.
 */
export async function handleFaqCommand(interaction: ChatInputCommandInteraction<"cached">) {
  const entry = interaction.options.getString("entry");
  if (entry) return sendFaqEntry(interaction, entry);
  await interaction.reply({ ...panelView(interaction.guildId, 0), flags: MessageFlags.Ephemeral });
}

/** The panel's home screen: what each button does, the most asked questions, and a menu of every entry. */
function panelView(guildId: string, page: number, note?: string) {
  const entries = faqs.list(guildId);
  const enabled = faqEnabled();
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  page = Math.min(Math.max(page, 0), pages - 1);

  const embed = new EmbedBuilder()
    .setColor(Colors.brand)
    .setTitle("📚 FAQ")
    .setDescription(
      [
        "**Answering a support post?** Run `/faq` inside the post and choose an entry in the `entry` option. " +
          "The suggestions match the post, and the person who asked gets pinged.",
        "",
        "**Managing the FAQ** (only you can see this):",
        "✨ **Generate**: Claude reads your resolved support posts and adds the questions that keep coming up.",
        "🧹 **Merge**: Claude combines duplicates and keeps the most asked. You approve a preview first.",
        "➕ **Add entry**: write one yourself.",
        "✏️ **Pick an entry** from the menu to read, edit or delete it.",
        "📢 **Publish**: post the whole FAQ to a channel or forum for people to browse.",
        "📄 **Download**: get the FAQ as a file.",
        ...(enabled ? [] : ["", "-# Generate and Merge are off until the bot has an `ANTHROPIC_API_KEY`."]),
      ].join("\n"),
    );

  if (entries.length) {
    const top = entries
      .slice(0, TOP_COUNT)
      .map((entry, index) => `${index + 1}. ${truncate(entry.question, 80)} · asked ${faqRelevance(entry)}×`);
    embed
      .addFields({ name: "Most asked", value: truncate(top.join("\n"), 1024) })
      .setFooter({
        text: `${entries.length} ${entries.length === 1 ? "entry" : "entries"} · Asked = posts that asked it + times sent with /faq`,
      });
  } else {
    embed.addFields({
      name: "The FAQ is empty",
      value: "Press **Generate** to build it from your support history, or **Add entry** to write one.",
    });
  }

  const rows: Row[] = [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(id("generate"))
        .setLabel("Generate")
        .setEmoji("✨")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!enabled),
      new ButtonBuilder()
        .setCustomId(id("merge"))
        .setLabel("Merge")
        .setEmoji("🧹")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!enabled || entries.length < 2),
      new ButtonBuilder().setCustomId(id("add")).setLabel("Add entry").setEmoji("➕").setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(id("publish"))
        .setLabel("Publish")
        .setEmoji("📢")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(entries.length === 0),
      new ButtonBuilder()
        .setCustomId(id("download"))
        .setLabel("Download")
        .setEmoji("📄")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(entries.length === 0),
    ),
  ];

  if (entries.length) {
    const start = page * PAGE_SIZE;
    rows.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(id("pick"))
          .setPlaceholder(pages > 1 ? `✏️ Pick an entry (page ${page + 1} of ${pages})…` : "✏️ Pick an entry…")
          .addOptions(
            entries.slice(start, start + PAGE_SIZE).map((entry, index) => ({
              label: truncate(`${start + index + 1}. ${entry.question}`, 100),
              description: truncate(`${entry.category} · asked ${faqRelevance(entry)}× · #${entry.id}`, 100),
              value: String(entry.id),
            })),
          ),
      ),
    );
  }

  if (pages > 1) {
    rows.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(id(`page:${page - 1}`))
          .setLabel("◀ More asked")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(id(`page:${page + 1}`))
          .setLabel("Less asked ▶")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === pages - 1),
      ),
    );
  }

  return { content: note ?? "", embeds: [embed], components: rows };
}

/** One entry, as `/faq` would send it, with buttons to edit or delete it. */
function entryView(entry: FaqEntry, guildId: string, note?: string) {
  const entries = faqs.list(guildId);
  const rank = entries.findIndex((e) => e.id === entry.id);
  const stats = new EmbedBuilder()
    .setColor(Colors.muted)
    .setDescription(
      `**#${rank + 1}** most asked: asked ${faqRelevance(entry)}× ` +
        `(${entry.sourceThreadIds.length} posts, sent ${entry.uses}×).\n` +
        `To send it, run \`/faq\` in a post and type \`#${entry.id}\` in \`entry\`.`,
    );

  return {
    content: note ?? "",
    embeds: [entryEmbed(entry), stats],
    components: [
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new ButtonBuilder().setCustomId(id(`edit:${entry.id}`)).setLabel("Edit").setEmoji("✏️").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(id(`delete:${entry.id}`)).setLabel("Delete").setEmoji("🗑️").setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(id(`page:${Math.floor(Math.max(rank, 0) / PAGE_SIZE)}`))
          .setLabel("Back to FAQ")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function requireEntry(guildId: string, entryId: string | number) {
  const entry = faqs.get(guildId, Number(entryId));
  if (!entry) throw new SyncError("That entry no longer exists. Run `/faq` again to see the current list.");
  return entry;
}

/** Buttons and the entry menu on the panel. */
export async function handleFaqPanelComponent(
  interaction: ButtonInteraction<"cached"> | StringSelectMenuInteraction<"cached">,
) {
  if (!isStaff(interaction)) throw new SyncError("Only staff can manage the FAQ.");
  const [action, arg] = interaction.customId.slice(ComponentIds.faq.length).split(":");
  const { guildId } = interaction;

  switch (action) {
    case "page":
      return interaction.update(panelView(guildId, Number(arg)));
    case "pick":
      if (!interaction.isStringSelectMenu()) return;
      return interaction.update(entryView(requireEntry(guildId, interaction.values[0]!), guildId));
    case "view":
      return interaction.update(entryView(requireEntry(guildId, arg!), guildId));
    case "edit":
      return interaction.showModal(faqModal(requireEntry(guildId, arg!)));
    case "delete": {
      const entry = requireEntry(guildId, arg!);
      return interaction.update({
        content: `Delete **${entry.question}**? This can't be undone.`,
        embeds: [],
        components: [
          new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
            new ButtonBuilder().setCustomId(id(`delete-confirm:${entry.id}`)).setLabel("Delete").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(id(`view:${entry.id}`)).setLabel("Keep it").setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    }
    case "delete-confirm": {
      const entry = requireEntry(guildId, arg!);
      faqs.remove(guildId, entry.id);
      return interaction.update(panelView(guildId, 0, `🗑️ Deleted **${entry.question}**.`));
    }
    case "add":
      return interaction.showModal(faqModal());
    case "download": {
      const entries = faqs.list(guildId);
      if (entries.length === 0) throw new SyncError("The FAQ is empty.");
      return interaction.reply({
        content: "The whole FAQ, most asked first:",
        files: [markdownFile(entries)],
        flags: MessageFlags.Ephemeral,
      });
    }
    case "generate":
      return interaction.showModal(
        new ModalBuilder()
          .setCustomId(id("generate-form"))
          .setTitle("Generate FAQ entries")
          .addLabelComponents(
            new LabelBuilder()
              .setLabel("How many days back should Claude read?")
              .setDescription("Between 1 and 365. Claude reads up to the 150 newest posts.")
              .setTextInputComponent(
                new TextInputBuilder().setCustomId("days").setStyle(TextInputStyle.Short).setValue("90").setMaxLength(3),
              ),
            new LabelBuilder()
              .setLabel("Which posts?")
              .setStringSelectMenuComponent(
                new StringSelectMenuBuilder()
                  .setCustomId("posts")
                  .addOptions(
                    {
                      label: "Only posts tagged Resolved",
                      description: "Questions that were definitely answered",
                      value: "resolved",
                      default: true,
                    },
                    {
                      label: "Every post someone replied to",
                      description: "Use this if older posts were never tagged",
                      value: "answered",
                    },
                  ),
              ),
          ),
      );
    case "merge":
      return interaction.showModal(
        new ModalBuilder()
          .setCustomId(id("merge-form"))
          .setTitle("Merge the FAQ")
          .addLabelComponents(
            new LabelBuilder()
              .setLabel("Keep at most how many entries?")
              .setDescription("Claude combines duplicates and drops rarely asked ones. You see a preview first.")
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId("keep")
                  .setStyle(TextInputStyle.Short)
                  .setValue(String(DEFAULT_KEEP))
                  .setMaxLength(3),
              ),
          ),
      );
    case "publish":
      return interaction.showModal(
        new ModalBuilder()
          .setCustomId(id("publish-form"))
          .setTitle("Publish the FAQ")
          .addLabelComponents(
            new LabelBuilder()
              .setLabel("Where should it go?")
              .setDescription("A channel gets the FAQ as embeds. A forum gets one post per question.")
              .setChannelSelectMenuComponent(
                new ChannelSelectMenuBuilder()
                  .setCustomId("channel")
                  .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum),
              ),
          ),
      );
  }
}

/** Forms opened from the panel, including adding and editing entries. */
export async function handleFaqPanelModal(interaction: ModalSubmitInteraction<"cached">) {
  if (!isStaff(interaction)) throw new SyncError("Only staff can manage the FAQ.");

  if (interaction.customId.startsWith(ComponentIds.faqForm)) {
    const entry = saveFaqForm(interaction);
    const view = entryView(entry, interaction.guildId, "✅ Saved. This is how it looks when sent:");
    // Opened from the panel: show the saved entry in place of it.
    if (interaction.isFromMessage()) await interaction.update(view);
    else await interaction.reply({ ...view, flags: MessageFlags.Ephemeral });
    return;
  }

  switch (interaction.customId.slice(ComponentIds.faq.length)) {
    case "generate-form": {
      const days = wholeNumber(interaction.fields.getTextInputValue("days"), 1, 365, "Days");
      const resolvedOnly = interaction.fields.getStringSelectValues("posts")[0] !== "answered";
      return generateFaq(interaction, days, resolvedOnly);
    }
    case "merge-form":
      return mergeFaqPreview(interaction, wholeNumber(interaction.fields.getTextInputValue("keep"), 1, 100, "The number to keep"));
    case "publish-form": {
      const channel = interaction.fields.getSelectedChannels("channel")?.first();
      if (
        !channel ||
        (channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildAnnouncement &&
          channel.type !== ChannelType.GuildForum)
      ) {
        throw new SyncError("Pick a text channel, announcement channel or forum.");
      }
      return publishFaq(interaction, channel);
    }
  }
}

function wholeNumber(text: string, min: number, max: number, name: string) {
  const value = Number(text.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SyncError(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}
