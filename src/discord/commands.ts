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
    .addStringOption((opt) =>
      opt
        .setName("reason")
        .setDescription("Why the post is being closed (default: Resolved; Added/Rejected are staff only)")
        .addChoices(
          { name: "Resolved: answered or solved", value: "resolved" },
          { name: "Added: fixed or implemented", value: "added" },
          { name: "Rejected: won't be done", value: "rejected" },
        ),
    )
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
            .addStringOption((opt) =>
              opt
                .setName("repo")
                .setDescription("GitHub repo for this forum's issues, as owner/repo (default: the bot's default repo)")
                .setMaxLength(140),
            )
            .addBooleanOption((opt) =>
              opt
                .setName("create_tags")
                .setDescription("Create the bot's status and resolved tags if missing (default: true)"),
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
        )
        .addSubcommand((sub) =>
          sub
            .setName("details")
            .setDescription("Choose the questions short new posts are asked (opens a form)")
            .addChannelOption((opt) =>
              opt
                .setName("channel")
                .setDescription("The forum channel")
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildForum),
            )
            .addBooleanOption((opt) =>
              opt.setName("reset").setDescription("Go back to the default questions instead of opening the form"),
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
    .addSubcommandGroup((group) =>
      group
        .setName("alerts")
        .setDescription("Get alerted about posts that no staff member has replied to")
        .addSubcommand((sub) =>
          sub
            .setName("on")
            .setDescription("Post an alert when a post has no staff reply after a while")
            .addChannelOption((opt) =>
              opt
                .setName("channel")
                .setDescription("Where to post alerts")
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
            )
            .addNumberOption((opt) =>
              opt
                .setName("after_hours")
                .setDescription("Hours without a staff reply before alerting (e.g. 0.5, 4, 24)")
                .setRequired(true)
                .setMinValue(0.25)
                .setMaxValue(168),
            )
            .addRoleOption((opt) => opt.setName("role").setDescription("Role to ping with each alert")),
        )
        .addSubcommand((sub) => sub.setName("off").setDescription("Stop posting unanswered-post alerts")),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("autoclose")
        .setDescription("Close support posts whose author stops replying")
        .addSubcommand((sub) =>
          sub
            .setName("on")
            .setDescription("Close a support post when its author hasn't replied to staff for a while")
            .addNumberOption((opt) =>
              opt
                .setName("after_days")
                .setDescription("Days without a reply from the author after staff answered (e.g. 3, 7)")
                .setRequired(true)
                .setMinValue(0.5)
                .setMaxValue(90),
            ),
        )
        .addSubcommand((sub) => sub.setName("off").setDescription("Stop closing inactive posts")),
    )
    .addSubcommand((sub) => sub.setName("show").setDescription("Show the current bot configuration")),

  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Show support activity and response times for this server")
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((opt) =>
      opt.setName("days").setDescription("How many days to look back (default: 30)").setMinValue(1).setMaxValue(365),
    ),

  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Post or edit embedded announcements")
    .setContexts(InteractionContextType.Guild)
    // Visible to everyone so roles added with /setup staff can use it; access is checked at runtime.
    .addSubcommand((sub) =>
      sub
        .setName("post")
        .setDescription("Build an embedded announcement, with a live preview, then post it")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Where to post it (default: this channel)")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addRoleOption((opt) =>
          opt.setName("ping").setDescription("Role to ping with the announcement (can be @everyone)"),
        )
        .addBooleanOption((opt) =>
          opt
            .setName("publish")
            .setDescription("Publish to servers following this announcement channel (default: false)"),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("edit")
        .setDescription("Open an announcement in the builder to change it")
        .addStringOption((opt) =>
          opt.setName("message").setDescription("Link to the announcement (or its message ID)").setRequired(true),
        ),
    ),

  new SlashCommandBuilder()
    .setName("faq")
    .setDescription("Compile a FAQ from resolved support posts with Claude")
    .setContexts(InteractionContextType.Guild)
    // Visible to everyone so roles added with /setup staff can use it; access is checked at runtime.
    .addSubcommand((sub) =>
      sub
        .setName("generate")
        .setDescription("Draft a FAQ from the support forums' history, or post it to a channel")
        .addIntegerOption((opt) =>
          opt.setName("days").setDescription("How many days of forum history to read (default: 90)").setMinValue(1).setMaxValue(365),
        )
        .addBooleanOption((opt) =>
          opt
            .setName("resolved_only")
            .setDescription("Only use posts tagged Resolved; false uses any post with replies (default: true)"),
        )
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Where to post the FAQ; a forum gets one post per question (default: only show a draft)")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum),
        ),
    ),
].map((command) => command.toJSON());

/** Registers commands globally so they work in every server the bot is invited to. */
export async function registerCommands(client: Client<true>) {
  await client.application.commands.set(commands);
  console.log(`Registered ${commands.length} global slash commands`);
}
