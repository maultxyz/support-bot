import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Client,
} from "discord.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("issue")
    .setDescription("Manage the GitHub issue linked to this forum post")
    .setContexts(InteractionContextType.Guild)
    // Visible to everyone so roles added with /setup staff can use it; access is checked at runtime.
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("Create a GitHub issue from this post")
        .addStringOption((opt) =>
          opt
            .setName("type")
            .setDescription("Issue type (defaults to the forum's type)")
            .addChoices(
              { name: "Support / bug", value: "support" },
              { name: "Feature request", value: "feature" },
            ),
        )
        .addStringOption((opt) =>
          opt.setName("title").setDescription("Issue title (defaults to the post title)").setMaxLength(256),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("link")
        .setDescription("Link this post to an existing GitHub issue")
        .addIntegerOption((opt) =>
          opt.setName("number").setDescription("Issue number").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) => sub.setName("unlink").setDescription("Unlink this post from its GitHub issue"))
    .addSubcommand((sub) => sub.setName("status").setDescription("Show the linked GitHub issue")),

  new SlashCommandBuilder()
    .setName("resolve")
    .setDescription("Mark this post as resolved and close it")
    .setContexts(InteractionContextType.Guild)
    .addBooleanOption((opt) =>
      opt
        .setName("close_issue")
        .setDescription("Also close the linked GitHub issue (staff only, default: true)"),
    ),

  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Configure the support bot")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommandGroup((group) =>
      group
        .setName("forum")
        .setDescription("Choose which forums the bot manages")
        .addSubcommand((sub) =>
          sub
            .setName("add")
            .setDescription("Register a forum as a support or feature-request forum")
            .addChannelOption((opt) =>
              opt
                .setName("channel")
                .setDescription("The forum channel")
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildForum),
            )
            .addStringOption((opt) =>
              opt
                .setName("type")
                .setDescription("What kind of posts this forum holds")
                .setRequired(true)
                .addChoices(
                  { name: "Support / bug", value: "support" },
                  { name: "Feature request", value: "feature" },
                ),
            )
            .addBooleanOption((opt) =>
              opt
                .setName("create_tags")
                .setDescription("Create the resolved/tracked tags in this forum if missing (default: true)"),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("Stop managing a forum")
            .addChannelOption((opt) =>
              opt
                .setName("channel")
                .setDescription("The forum channel")
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildForum),
            ),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("staff")
        .setDescription("Choose which roles count as support staff")
        .addSubcommand((sub) =>
          sub
            .setName("add")
            .setDescription("Let a role manage GitHub issues and resolve any post")
            .addRoleOption((opt) => opt.setName("role").setDescription("The role").setRequired(true)),
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("Remove a role from support staff")
            .addRoleOption((opt) => opt.setName("role").setDescription("The role").setRequired(true)),
        ),
    )
    .addSubcommand((sub) => sub.setName("show").setDescription("Show the current bot configuration")),
].map((command) => command.toJSON());

/** Registers commands globally so they work in every server the bot is invited to. */
export async function registerCommands(client: Client<true>) {
  await client.application.commands.set(commands);
  console.log(`Registered ${commands.length} global slash commands`);
}
