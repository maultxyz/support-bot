# support-bot

A Discord support bot for **forum channels** that syncs support and feature requests to **GitHub issues** in both directions. It's built with [discord.js](https://discord.js.org) and [Hono](https://hono.dev) and runs in Docker, for example on [Coolify](https://coolify.io).

## Features

- **Configured from Discord.** Use `/setup forum add` to register any number of support or feature-request forums, and `/setup staff add` to choose which roles count as staff. Neither needs env vars.
- **A repo per forum.** Each forum can file issues into its own GitHub repo (`/setup forum add … repo:owner/name`), so one bot can serve several projects or servers. Forums without one use `GITHUB_OWNER`/`GITHUB_REPO`.
- **Status tags.** Posts linked to an issue are tagged `Pending` while the issue is open, `Added` when it's closed as completed, and `Rejected` when it's closed as not planned or a duplicate. The bot never changes post titles.
- **Closing reasons.** Every closed post is tagged with why it was closed: `Resolved` (answered or solved), `Added` (fixed or implemented), or `Rejected` (won't be done). When staff press **Mark resolved**, they pick the reason from a private menu. A post's author can close it themselves, but only as `Resolved`.
- **Forum-based support.** Every new post in a registered forum gets a welcome message with **Track on GitHub** and **Mark resolved** buttons.
- **Possibly related issues.** The welcome message lists up to 3 existing issues in the forum's repo whose titles share keywords with the new post, with a link to the Discord post each one is tracked in.
- **Topic tagging prompt.** If a new post has no topic tag yet, the welcome message includes a menu of the forum's tags (e.g. `3D Model`, `Web`, `Server`, `Discord`). The author or staff pick up to 4, and the bot applies them. Topic tags are simply the forum's own tags, managed in the forum's Discord settings. The bot's status tags and any moderated tags are left out.
- **Discord → GitHub**
  - Staff turn a post into a GitHub issue. The post's title becomes the issue title, its first message and attachments become the issue body, and the issue is labelled by request type plus the post's topic tags (e.g. `enhancement`, `3D Model`, `Web`).
  - `/issue link <number>` attaches a post to an issue that already exists.
  - Topic tags added to a linked post later become labels on its issue. Removing a tag in Discord doesn't remove the label, so triage done on GitHub isn't undone. GitHub creates any label that doesn't exist yet.
  - Replies in a linked post are mirrored as issue comments.
  - Closing a linked post as staff also closes its issue. `Rejected` closes it as *not planned*, and the other reasons close it as *completed*.
- **Votes on feature requests.** Each member who reacts to a feature request's first message counts as one vote (the author and bots don't count). The total is kept in a `👍 N votes on Discord` line at the end of the linked issue's body, and the most-voted open requests appear in `/stats`.
- **Unanswered-post alerts.** With `/setup alerts on`, the bot posts in a staff channel (optionally pinging a role) when a post has gone a set time without a reply from staff. Staff replies on Discord and comments on the linked GitHub issue both count.
- **Closing inactive posts.** With `/setup autoclose on`, a support post closes on its own when staff replied last and the author hasn't answered for the set time. The bot posts a closing message with a **Reactivate** button (for the author or staff), tags the post `Resolved`, and closes it. The author can also reopen it just by sending a message. Feature requests and posts linked to a GitHub issue are never closed this way.
- **Stats.** `/stats` shows new and closed posts, closing reasons, open and unanswered counts, first-response and time-to-close medians, top topics, and most-voted feature requests.
- **GitHub → Discord** (via webhook)
  - New issue comments are posted into the thread.
  - When someone is assigned to the issue, the bot posts that they're working on it.
  - When the issue is closed, the bot posts a notice, swaps the tag to `Added` or `Rejected`, and closes the post. If it was completed, the notice links the pull request or commit that closed it and pings the post's author.
  - When a release is published, the bot finds the issues it ships (mentioned in the release notes directly, or closed by a pull request the notes mention) and tells each linked post which release it's in, pinging the author.
  - When the issue is reopened, the bot reopens the post and sets the tag back to `Pending`.
- **No echo loops.** Comments the bot writes on GitHub carry a hidden marker, and issue closes the bot triggers itself are skipped, so nothing gets mirrored twice.

## Commands

| Command | Who | What it does |
| --- | --- | --- |
| `/setup forum add <channel> <type> [repo] [create_tags]` | Manage Server | Register a forum as support or feature requests, filing issues into `repo` (`owner/name`; defaults to `GITHUB_OWNER`/`GITHUB_REPO`). Run it again to change the type or repo. Checks the bot's permissions and creates missing tags |
| `/setup forum remove <channel>` | Manage Server | Stop managing a forum |
| `/setup staff add <role>` | Manage Server | Make a role support staff |
| `/setup staff remove <role>` | Manage Server | Remove a role from support staff |
| `/setup alerts on <channel> <after_hours> [role]` | Manage Server | Alert in `channel` when a post has had no staff reply for `after_hours`, optionally pinging `role` |
| `/setup alerts off` | Manage Server | Stop unanswered-post alerts |
| `/setup autoclose on <after_days>` | Manage Server | Close support posts whose author hasn't replied to staff for `after_days` |
| `/setup autoclose off` | Manage Server | Stop closing inactive posts |
| `/setup show` | Manage Server | Show the registered forums and their repos, staff roles, alert and auto-close settings |
| `/issue create [type] [title]` | Staff | Create a GitHub issue from this post |
| `/issue link <number>` | Staff | Link this post to an existing issue |
| `/issue unlink` | Staff | Remove the link (the issue is left untouched) |
| `/issue status` | Staff | Show the linked issue's state, labels, and assignees |
| `/stats [days]` | Staff | Support activity for the last `days` (default 30), shown only to you |
| `/resolve [reason] [close_issue]` | Post author or staff | Close the post and tag it with the reason: **Resolved** (default), **Added**, or **Rejected**. Only staff can choose Added or Rejected. Staff also close the linked issue (default `true`) |

**Staff** means members with a role added through `/setup staff add`, plus anyone with **Manage Threads** (so moderators work before any roles are set up). Staff can use `/issue` and `/stats` and resolve any post. Everyone can see `/issue` and `/stats`, but the bot rejects non-staff when they run them. `/setup` is hidden from members without Manage Server. To change that, go to *Server Settings → Integrations*.

## Setup

### 1. Discord application

1. Create an application at <https://discord.com/developers/applications> and add a **Bot**.
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**. Without it, Discord refuses the connection and the bot exits with `Used disallowed intents`. Once the bot is in 100 or more servers, Discord requires verification before it grants this intent.
3. Invite the bot to a server. On startup the bot prints a ready-made **invite link** in its logs. To build one by hand, use the `bot` and `applications.commands` scopes and these permissions: View Channels, Send Messages, Send Messages in Threads, Embed Links, Read Message History, **Manage Threads** (needed to archive posts and edit their tags). **Manage Channels** is optional: it lets `/setup forum add` create the `Pending`, `Added`, `Rejected`, and `Resolved` tags for you. The status tags are created as moderated, so only staff can apply them by hand.
4. To let other people invite the bot, leave **Public Bot** on under *Bot*. To keep it to servers you invite it to, turn it off.
5. Once the bot is running, run `/setup forum add` for each forum. The reply tells you if the bot lacks permissions in that forum. Then run `/setup staff add` for each support role.

### 2. GitHub

1. Create a **fine-grained personal access token** limited to the repos the bot files into, with **Issues: Read and write**, **Pull requests: Read**, and **Contents: Read**. The last two let the bot say which pull request or commit fixed an issue and which release shipped it; without them, those notices are left out. Issues and comments will appear under that account, so a dedicated bot account looks cleanest.
2. In each repo (or once for the whole organization), go to *Settings → Webhooks → Add webhook*:
   - **Payload URL:** `https://<your-domain>/webhooks/github`
   - **Content type:** `application/json`
   - **Secret:** the same value as `GITHUB_WEBHOOK_SECRET`
   - **Events:** *Let me select individual events* → **Issues**, **Issue comments**, and **Releases**

### 3. Configure

Copy `.env.example` to `.env` and fill it in. See that file for what each variable does.

### 4. Run locally

```sh
npm install
npm run dev
```

Requires Node.js 22.13 or newer (it uses the built-in `node:sqlite`). To receive GitHub webhooks locally, expose port 3000 with a tunnel such as `cloudflared` or `ngrok`.

## Deploying on Coolify

**Option A: Dockerfile (simplest)**

1. *New Resource → Public/Private Repository*, then pick this repo and choose the **Dockerfile** build pack.
2. Set **Ports Exposes** to `3000` and assign a domain. The domain is what GitHub's webhook calls.
3. Under *Persistent Storage*, add a volume mounted at **`/app/data`**. This holds the SQLite database of forums, staff roles, and thread ↔ issue links. Without it, all of these are lost on every redeploy.
4. Add the variables from `.env.example` under *Environment Variables*.
5. Deploy. Coolify uses the image's `HEALTHCHECK`, which calls `/health` and returns 200 once the bot is connected to Discord.

**Option B: Docker Compose.** Choose the **Docker Compose** build pack instead. `docker-compose.yml` already declares the volume, and Coolify will list every variable for you to fill in.

> Run only **one** instance. Running two means two gateway connections, and every event gets handled twice.

## HTTP endpoints

| Route | Purpose |
| --- | --- |
| `GET /health` | `200` when connected to Discord, `503` otherwise |
| `POST /webhooks/github` | GitHub webhook receiver (HMAC-SHA256 verified) |

## Project layout

```
src/
  index.ts           boot: Hono server + Discord login + graceful shutdown
  config.ts          env validation (zod)
  db.ts              SQLite store: thread ↔ issue links, forums, staff roles, posts, server settings
  github.ts          Octokit helpers
  sync.ts            Discord → GitHub logic (create/link/resolve/mirror)
  tracking.ts        post tracking, votes, unanswered alerts, inactive-post closing
  github-events.ts   GitHub → Discord webhook handling
  server.ts          Hono routes
  discord/
    client.ts        gateway client + event wiring
    commands.ts      slash command definitions/registration
    interactions.ts  slash command + button handlers
    setup.ts         /setup: forums, staff roles, alerts, auto-close
    stats.ts         /stats
    util.ts          tags, permissions, embeds
```

## Notes

- Attachments are linked from the issue as Discord CDN URLs. These links can expire, so for long-lived issues, re-upload important screenshots to GitHub.
- Slash commands are registered globally on startup, so they work in every server. Each server has its own forums, staff roles, and alert settings, set up with `/setup`. Each forum files into its own repo, or the one set by `GITHUB_OWNER`/`GITHUB_REPO`.
- Alerts, auto-close, and `/stats` only know about posts created while this version of the bot was running. Alerts also skip posts more than a week old, so turning them on doesn't flood the channel.
- When the bot is removed from a server, that server's forums, staff roles, issue links, post history, and settings are deleted. The GitHub issues themselves are left alone.
