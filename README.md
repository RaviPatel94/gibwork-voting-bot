# discord-role-sync

A one-shot local script (**not** a persistent bot) that manages a Discord role based on who reacted to a message or voted on a poll.

It does the following, in order, every time you run it:

1. **Resets** the target role — removes it from every member currently holding it.
2. **Validates** everything up front (IDs, permissions, message/poll type) before touching anything.
3. **Waits** a configurable amount of time (the "voting window").
4. **Tallies** users who reacted with a specific emoji, or voted on a poll.
5. **Grants** the role to those users.
6. **Deletes** the original message.

The process then exits. It does not stay connected or listen for future events.

---

## How it works — flow

```
validate env vars
      │
fetch guild → fetch role
      │
fetch channel → fetch message (skipped if ACTION=RESET)
      │
check SOURCE_TYPE matches the message (poll vs non-poll)
      │
check bot permissions (Manage Roles, role hierarchy, Manage Messages)
      │
RESET the role (remove from all current holders)
      │
ACTION=RESET? ── yes ──> stop here
      │ no
wait DELETE_AFTER_MINUTES
      │
re-fetch the message
      │
message still exists? ── no ──> log it, stop (no roles granted)
      │ yes
SOURCE_TYPE=REACTION ──> collect users who used EMOJI
SOURCE_TYPE=POLL     ──> collect users who voted on ANY poll answer
      │
ADD the role to each collected user (skip if they already have it)
      │
DELETE the message
```

### Reaction mode vs Poll mode

- **`SOURCE_TYPE=REACTION`**: looks at the message's reactions, finds the one matching `EMOJI`, and pulls every user who reacted with it. Bots are ignored.
- **`SOURCE_TYPE=POLL`**: looks at the message's native Discord poll and pulls every unique user who voted, across **all** answer options (not just one side). Bots are ignored. `EMOJI` is not used in this mode.

The script checks the message actually matches your chosen mode before doing anything else — see error handling below.

---

## Setup

### 1. Create the bot application

1. Go to https://discord.com/developers/applications → **New Application**.
2. Go to **Bot** → **Reset Token** → copy it (you'll need it for `DISCORD_TOKEN`).
3. On the same page, enable these two **privileged intents**:
   - **Server Members Intent**
   - **Message Content Intent**

### 2. Invite the bot to your server

1. Go to **OAuth2 → URL Generator**.
2. Under **Scopes**, check **`bot`**.
3. Under **Bot Permissions**, check:
   - Manage Roles
   - Manage Messages
   - View Channels
   - Read Message History
4. Copy the generated URL, open it, and add the bot to your server.
5. In **Server Settings → Roles**, drag the bot's own role **above** the role it needs to manage (Discord won't let a bot grant/remove a role positioned above its own).

### 3. Get the IDs you need

Enable Developer Mode first: **User Settings → Advanced → Developer Mode**.

| ID | How to copy it |
|---|---|
| `GUILD_ID` | Right-click your server icon → Copy Server ID |
| `CHANNEL_ID` | Right-click the channel containing the message → Copy Channel ID |
| `MESSAGE_ID` | Right-click the message/poll itself → Copy Message ID |
| `ROLE_ID` | Server Settings → Roles → right-click the role → Copy Role ID |

### 4. Install & run

```bash
npm install
cp .env.example .env
# fill in .env with your values
npm start
```

---

## Environment variables (`.env`)

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | yes | Your bot's token |
| `GUILD_ID` | yes | Server ID |
| `CHANNEL_ID` | yes (unless `ACTION=RESET`) | Channel ID containing the message |
| `MESSAGE_ID` | yes (unless `ACTION=RESET`) | The target message/poll ID |
| `ROLE_ID` | yes | The role to reset and grant |
| `ACTION` | no (default `ADD`) | `ADD` = reset + tally + grant. `RESET` = only reset the role, nothing else runs |
| `SOURCE_TYPE` | no (default `REACTION`) | `REACTION` or `POLL` |
| `EMOJI` | yes if `SOURCE_TYPE=REACTION` | Unicode emoji (e.g. `✅`) or custom emoji name/ID |
| `DELETE_AFTER_MINUTES` | no (default `0`) | Minutes to wait between reset and tallying/granting/deleting. `0` skips the wait — the message will be checked and acted on immediately |

---

## Error handling

Every step is validated **before** the role reset runs, so a bad config fails fast without partially resetting anyone's roles first.

| Situation | Behavior |
|---|---|
| `GUILD_ID` wrong | `[GUILD] GUILD_ID is incorrect — server not found (or bot is not in that server).` — script stops |
| `ROLE_ID` wrong | `[ROLE] ROLE_ID is incorrect — role not found in that server.` — script stops |
| `CHANNEL_ID` wrong | `[CHANNEL] CHANNEL_ID is incorrect — channel not found.` — script stops |
| `MESSAGE_ID` wrong / message doesn't exist | `[MESSAGE] MESSAGE_ID is incorrect, or the original message was deleted.` — script stops |
| `SOURCE_TYPE=POLL` but the message isn't a poll | `[SOURCE_TYPE] SOURCE_TYPE=POLL but MESSAGE_ID points to a message with no poll attached.` — script stops |
| `SOURCE_TYPE=REACTION` but the message is a poll | `[SOURCE_TYPE] SOURCE_TYPE=REACTION but MESSAGE_ID points to a poll message, not a reaction message.` — script stops |
| Bot lacks Manage Roles | `[PERMISSIONS] Bot is missing the "Manage Roles" permission in this server.` — script stops |
| Bot's role is below the target role | `[PERMISSIONS] Bot's role must be positioned above "<role>" in Server Settings → Roles.` — script stops |
| Bot lacks Manage Messages | `[PERMISSIONS] Bot is missing the "Manage Messages" permission...` — script stops |
| Missing env var | `Missing env var: <NAME>` — script stops |
| `SOURCE_TYPE=REACTION` with no `EMOJI` set | `EMOJI is required when SOURCE_TYPE=REACTION` — script stops |
| **Original message deleted during the wait window** | Logged clearly, role is **not** granted to anyone, script exits normally (no crash) |
| Message already deleted when the script tries to delete it at the end | `[DELETE] Message was already deleted.` — logged, not treated as an error |
| Individual member fails during reset (e.g. left the server) | Logged per-user, loop continues for everyone else |
| Individual member fails during role-add (e.g. already has it, or a permission edge case) | Logged per-user, loop continues for everyone else |
| No reactions/votes found | Logged, script completes with 0 users processed |

Nothing in the script throws an uncaught exception — all failures are caught, logged with context, and the process exits cleanly.

---

## Notes

- Bots are always excluded from reactors/voters.
- For polls, users who voted on **any** answer are counted — not just one side.
- Nothing runs on a schedule or stays connected; run the script manually (or via a scheduler like cron/Task Scheduler) whenever you want to process a message.
