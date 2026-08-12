require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const {
  DISCORD_TOKEN,
  GUILD_ID,
  CHANNEL_ID,
  MESSAGE_ID,
  ROLE_ID,
  ACTION = 'ADD',          // ADD | RESET
  SOURCE_TYPE = 'REACTION', // REACTION | POLL
  EMOJI,                    // e.g. ✅ or customname:id
  DELETE_AFTER_MINUTES = '0'
} = process.env;

function assertEnv() {
  const required = { DISCORD_TOKEN, GUILD_ID, CHANNEL_ID, MESSAGE_ID, ROLE_ID };
  for (const [k, v] of Object.entries(required)) {
    if (!v) throw new Error(`Missing env var: ${k}`);
  }
  if (SOURCE_TYPE === 'REACTION' && !EMOJI) {
    throw new Error('EMOJI is required when SOURCE_TYPE=REACTION');
  }
}

function emojiMatches(reactionEmoji, target) {
  if (reactionEmoji.id) {
    return [reactionEmoji.id, reactionEmoji.name, `<:${reactionEmoji.name}:${reactionEmoji.id}>`].includes(target);
  }
  return reactionEmoji.name === target;
}

async function resetRole(guild, role) {
  console.log(`\n[RESET] Removing role "${role.name}" from all current holders...`);
  await guild.members.fetch(); // populate cache
  const holders = guild.members.cache.filter(m => m.roles.cache.has(role.id));
  for (const member of holders.values()) {
    try {
      await member.roles.remove(role.id);
      console.log(`[RESET] Removed from ${member.user.tag}`);
    } catch (err) {
      console.error(`[RESET] Failed for ${member.user.tag}: ${err.message}`);
    }
  }
  console.log(`[RESET] Done. Cleared ${holders.size} member(s).`);
}

async function getReactionUsers(message) {
  const reaction = message.reactions.cache.find(r => emojiMatches(r.emoji, EMOJI));
  if (!reaction) {
    console.log(`[REACTION] No reactions found matching "${EMOJI}".`);
    return [];
  }
  const users = await reaction.users.fetch();
  return [...users.values()].filter(u => !u.bot);
}

async function getPollVoters(message) {
  if (!message.poll) {
    console.log('[POLL] The message has no poll attached to it.');
    return [];
  }
  const voters = new Map();
  for (const [, answer] of message.poll.answers) {
    const answerVoters = await answer.fetchVoters();
    answerVoters.forEach(u => { if (!u.bot) voters.set(u.id, u); });
  }
  return [...voters.values()];
}

async function addRoleToUsers(guild, role, users) {
  console.log(`\n[ADD] Adding role "${role.name}" to ${users.length} user(s)...`);
  for (const user of users) {
    try {
      const member = await guild.members.fetch(user.id);
      if (member.roles.cache.has(role.id)) {
        console.log(`[ADD] ${user.tag} already has the role, skipping.`);
        continue;
      }
      await member.roles.add(role.id);
      console.log(`[ADD] Role added to ${user.tag}`);
    } catch (err) {
      console.error(`[ADD] Failed for ${user.tag}: ${err.message}`);
    }
  }
}

async function waitBeforeFinalStep() {
  const minutes = parseFloat(DELETE_AFTER_MINUTES);
  if (!minutes || minutes <= 0) return;
  console.log(`\n[WAIT] Voting window open for ${minutes} minute(s)...`);
  await new Promise(res => setTimeout(res, minutes * 60 * 1000));
}

async function deleteMessage(message) {
  try {
    await message.delete();
    console.log('[DELETE] Message deleted.');
  } catch (err) {
    if (err.code === 10008) {
      console.log('[DELETE] Message was already deleted.');
      return;
    }
    console.error(`[DELETE] Failed: ${err.message}`);
  }
}

function friendlyError(err, context) {
  const code = err.code;
  const map = {
    10004: 'GUILD_ID is incorrect — server not found (or bot is not in that server).',
    10011: 'ROLE_ID is incorrect — role not found in that server.',
    10003: 'CHANNEL_ID is incorrect — channel not found (or bot cannot see it).',
    10008: 'MESSAGE_ID is incorrect, or the original message was deleted.',
    50001: 'Missing Access — bot cannot see that channel/message. Check channel permission overwrites.',
    50013: 'Missing Permissions — check the bot has Manage Roles/Manage Messages and its role is positioned above the target role.',
    50035: 'Invalid form body — one of the IDs is malformed (not a valid snowflake).'
  };
  const known = map[code];
  return known ? `[${context}] ${known}` : `[${context}] ${err.message}`;
}

async function run(client) {
  assertEnv();

  let guild;
  try {
    guild = await client.guilds.fetch(GUILD_ID);
  } catch (err) {
    throw new Error(friendlyError(err, 'GUILD'));
  }

  let role;
  try {
    role = await guild.roles.fetch(ROLE_ID);
    if (!role) throw new Error(`[ROLE] ROLE_ID is incorrect — role not found in that server.`);
  } catch (err) {
    if (err.message.startsWith('[ROLE]')) throw err;
    throw new Error(friendlyError(err, 'ROLE'));
  }

  let channel = null;
  let message = null;
  if (ACTION !== 'RESET') {
    try {
      channel = await client.channels.fetch(CHANNEL_ID);
      if (!channel) throw new Error('[CHANNEL] CHANNEL_ID is incorrect — channel not found.');
    } catch (err) {
      if (err.message.startsWith('[CHANNEL]')) throw err;
      throw new Error(friendlyError(err, 'CHANNEL'));
    }

    try {
      message = await channel.messages.fetch({ message: MESSAGE_ID, force: true });
    } catch (err) {
      throw new Error(friendlyError(err, 'MESSAGE'));
    }

    if (SOURCE_TYPE === 'POLL' && !message.poll) {
      throw new Error('[SOURCE_TYPE] SOURCE_TYPE=POLL but MESSAGE_ID points to a message with no poll attached.');
    }
    if (SOURCE_TYPE === 'REACTION' && message.poll) {
      throw new Error('[SOURCE_TYPE] SOURCE_TYPE=REACTION but MESSAGE_ID points to a poll message, not a reaction message.');
    }
  }

  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has('ManageRoles')) {
    throw new Error('[PERMISSIONS] Bot is missing the "Manage Roles" permission in this server.');
  }
  if (botMember.roles.highest.comparePositionTo(role) <= 0) {
    throw new Error(`[PERMISSIONS] Bot's role must be positioned above "${role.name}" in Server Settings → Roles.`);
  }
  if (channel && !botMember.permissions.has('ManageMessages')) {
    throw new Error('[PERMISSIONS] Bot is missing the "Manage Messages" permission (needed to delete the message later).');
  }

  await resetRole(guild, role);

  if (ACTION === 'RESET') {
    console.log('\nACTION=RESET, stopping here (no role added).');
    return;
  }

  // Wait out the voting window first; only then tally votes and grant the role.
  await waitBeforeFinalStep();

  let freshMessage;
  try {
    freshMessage = await channel.messages.fetch({ message: MESSAGE_ID, force: true });
  } catch (err) {
    if (err.code === 10008) {
      console.error('[MESSAGE] The original message was deleted before votes/reactions could be tallied. No roles were granted.');
      return;
    }
    throw new Error(friendlyError(err, 'MESSAGE'));
  }

  const users = SOURCE_TYPE === 'POLL'
    ? await getPollVoters(freshMessage)
    : await getReactionUsers(freshMessage);

  await addRoleToUsers(guild, role, users);
  await deleteMessage(freshMessage);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User]
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await run(client);
    console.log('\nDone.');
  } catch (err) {
    console.error('\nFATAL:', err.message);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(DISCORD_TOKEN);