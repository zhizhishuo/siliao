import cors from 'cors'
import bcrypt from 'bcryptjs'
import Database from 'better-sqlite3'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import jwt from 'jsonwebtoken'
import multer from 'multer'
import { Server } from 'socket.io'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PORT = Number(process.env.PORT || 3001)
const JWT_SECRET = process.env.JWT_SECRET || 'chat-mvp-secret'
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173'

const dataDir = path.join(__dirname, 'data')
const uploadDir = path.join(dataDir, 'uploads')
fs.mkdirSync(uploadDir, { recursive: true })

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadDir),
  filename: (_req, file, callback) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
    callback(null, `${Date.now()}-${safeName}`)
  },
})

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
})

const db = new Database(path.join(dataDir, 'chat.db'))
db.pragma('journal_mode = WAL')

function ensureColumn(tableName, columnName, sqlDefinition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all()
  const hasColumn = columns.some((column) => column.name === columnName)

  if (!hasColumn) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${sqlDefinition}`)
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_one_id INTEGER NOT NULL,
    user_two_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_one_id, user_two_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    body TEXT,
    attachment_name TEXT,
    attachment_path TEXT,
    attachment_size INTEGER,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS direct_reads (
    conversation_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    last_read_message_id INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(conversation_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS channel_members (
    channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(channel_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS channel_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    body TEXT,
    attachment_name TEXT,
    attachment_path TEXT,
    attachment_size INTEGER,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS channel_reads (
    channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    last_read_message_id INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(channel_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_direct_reads_user_id ON direct_reads(user_id);
  CREATE INDEX IF NOT EXISTS idx_channel_members_user_id ON channel_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_channel_messages_channel_id ON channel_messages(channel_id);
  CREATE INDEX IF NOT EXISTS idx_channel_messages_created_at ON channel_messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_channel_reads_user_id ON channel_reads(user_id);
`)

ensureColumn('messages', 'deleted_at', 'deleted_at TEXT')
ensureColumn('channel_messages', 'deleted_at', 'deleted_at TEXT')
ensureColumn('users', 'role', "role TEXT NOT NULL DEFAULT 'member'")

const seededUsers = [
  {
    username: 'li.lei',
    displayName: '李雷',
    password: 'password123',
  },
  {
    username: 'han.mei',
    displayName: '韩梅梅',
    password: 'password123',
  },
  {
    username: 'wang.wei',
    displayName: '王伟',
    password: 'password123',
  },
]

const countUsers = db.prepare('SELECT COUNT(*) AS count FROM users').get()
if (countUsers.count === 0) {
  const insertUser = db.prepare(
    'INSERT INTO users (username, display_name, role, password_hash) VALUES (?, ?, ?, ?)',
  )

  for (const user of seededUsers) {
    insertUser.run(
      user.username,
      user.displayName,
      user.username === 'li.lei' ? 'admin' : 'member',
      bcrypt.hashSync(user.password, 10),
    )
  }
}

db.prepare("UPDATE users SET role = 'admin' WHERE username = 'li.lei'").run()

const seedChannelCount = db.prepare('SELECT COUNT(*) AS count FROM channels').get()
if (seedChannelCount.count === 0) {
  const insertSeedChannel = db.prepare(
    'INSERT INTO channels (name, created_by) VALUES (?, ?)',
  )
  const insertSeedChannelMember = db.prepare(
    'INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)',
  )
  const seedUsers = db
    .prepare('SELECT id FROM users ORDER BY id ASC')
    .all()

  if (seedUsers.length > 0) {
    const seedChannelId = Number(insertSeedChannel.run('全员群', seedUsers[0].id).lastInsertRowid)
    for (const user of seedUsers) {
      insertSeedChannelMember.run(seedChannelId, user.id)
    }
  }
}

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_ORIGIN,
    credentials: true,
  },
})

app.use(
  cors({
    origin: CLIENT_ORIGIN,
    credentials: true,
  }),
)
app.use(express.json())
app.use('/uploads', express.static(uploadDir))

const getUserById = db.prepare(
  'SELECT id, username, display_name AS displayName, role FROM users WHERE id = ?',
)
const getUserByUsername = db.prepare('SELECT * FROM users WHERE username = ?')
const getAllUsers = db.prepare(
  'SELECT id, username, display_name AS displayName, role, created_at AS createdAt FROM users ORDER BY display_name',
)
const getAllOtherUsers = db.prepare(
  'SELECT id, username, display_name AS displayName, role, created_at AS createdAt FROM users WHERE id != ? ORDER BY display_name',
)
const countChannels = db.prepare('SELECT COUNT(*) AS count FROM channels')
const countMessages = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM messages) + (SELECT COUNT(*) FROM channel_messages) AS count
`)
const countAdmins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'")
const countTodayMessages = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM messages WHERE date(created_at) = date('now', 'localtime'))
    + (SELECT COUNT(*) FROM channel_messages WHERE date(created_at) = date('now', 'localtime')) AS count
`)
const updateUserRole = db.prepare('UPDATE users SET role = ? WHERE id = ?')
const getConversationByUsers = db.prepare(
  'SELECT * FROM conversations WHERE user_one_id = ? AND user_two_id = ?',
)
const insertConversation = db.prepare(
  'INSERT INTO conversations (user_one_id, user_two_id) VALUES (?, ?)',
)
const getDirectMessagesForConversation = db.prepare(`
  SELECT
    messages.id,
    messages.conversation_id AS conversationId,
    messages.sender_id AS senderId,
    users.display_name AS senderName,
    messages.body,
    messages.attachment_name AS attachmentName,
    messages.attachment_path AS attachmentPath,
    messages.attachment_size AS attachmentSize,
    messages.deleted_at AS deletedAt,
    messages.created_at AS createdAt
  FROM messages
  JOIN users ON users.id = messages.sender_id
  WHERE messages.conversation_id = ?
  ORDER BY messages.created_at ASC, messages.id ASC
`)
const insertDirectMessage = db.prepare(`
  INSERT INTO messages (
    conversation_id,
    sender_id,
    body,
    attachment_name,
    attachment_path,
    attachment_size
  ) VALUES (?, ?, ?, ?, ?, ?)
`)
const getLatestDirectMessage = db.prepare(`
  SELECT
    id,
    sender_id AS senderId,
    body,
    attachment_name AS attachmentName,
    deleted_at AS deletedAt,
    created_at AS createdAt
  FROM messages
  WHERE conversation_id = ?
  ORDER BY created_at DESC, id DESC
  LIMIT 1
`)
const getLatestDirectMessageId = db.prepare(`
  SELECT id
  FROM messages
  WHERE conversation_id = ?
  ORDER BY id DESC
  LIMIT 1
`)
const getUnreadDirectCount = db.prepare(`
  SELECT COUNT(*) AS count
  FROM messages
  WHERE conversation_id = ?
    AND sender_id != ?
    AND deleted_at IS NULL
    AND id > COALESCE((
      SELECT last_read_message_id
      FROM direct_reads
      WHERE conversation_id = ? AND user_id = ?
    ), 0)
`)
const upsertDirectRead = db.prepare(`
  INSERT INTO direct_reads (conversation_id, user_id, last_read_message_id, updated_at)
  VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(conversation_id, user_id)
  DO UPDATE SET
    last_read_message_id = excluded.last_read_message_id,
    updated_at = CURRENT_TIMESTAMP
`)
const searchDirectMessages = db.prepare(`
  SELECT
    messages.id AS messageId,
    other_users.id AS peerId,
    other_users.display_name AS threadName,
    users.display_name AS senderName,
    messages.sender_id AS senderId,
    messages.body,
    messages.attachment_name AS attachmentName,
    messages.attachment_path AS attachmentPath,
    messages.attachment_size AS attachmentSize,
    messages.created_at AS createdAt
  FROM messages
  JOIN conversations ON conversations.id = messages.conversation_id
  JOIN users ON users.id = messages.sender_id
  JOIN users AS other_users
    ON other_users.id = CASE
      WHEN conversations.user_one_id = ? THEN conversations.user_two_id
      ELSE conversations.user_one_id
    END
  WHERE
    (conversations.user_one_id = ? OR conversations.user_two_id = ?)
    AND messages.deleted_at IS NULL
    AND (
      COALESCE(messages.body, '') LIKE ?
      OR COALESCE(messages.attachment_name, '') LIKE ?
    )
  ORDER BY messages.created_at DESC, messages.id DESC
  LIMIT 20
`)
const getChannelsForUser = db.prepare(`
  SELECT
    channels.id,
    channels.name,
    channels.created_by AS createdBy,
    channels.created_at AS createdAt
  FROM channels
  JOIN channel_members ON channel_members.channel_id = channels.id
  WHERE channel_members.user_id = ?
  ORDER BY channels.created_at ASC
`)
const getChannelById = db.prepare(`
  SELECT
    channels.id,
    channels.name,
    channels.created_by AS createdBy,
    channels.created_at AS createdAt
  FROM channels
  WHERE channels.id = ?
`)
const getChannelByIdForUser = db.prepare(`
  SELECT
    channels.id,
    channels.name,
    channels.created_by AS createdBy,
    channels.created_at AS createdAt
  FROM channels
  JOIN channel_members ON channel_members.channel_id = channels.id
  WHERE channels.id = ? AND channel_members.user_id = ?
`)
const getChannelMemberRecord = db.prepare(
  'SELECT channel_id AS channelId, user_id AS userId FROM channel_members WHERE channel_id = ? AND user_id = ?',
)
const insertChannel = db.prepare(
  'INSERT INTO channels (name, created_by) VALUES (?, ?)',
)
const insertChannelMember = db.prepare(
  'INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)',
)
const deleteChannelMember = db.prepare(
  'DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?',
)
const deleteChannelRead = db.prepare(
  'DELETE FROM channel_reads WHERE channel_id = ? AND user_id = ?',
)
const deleteAllChannelMembers = db.prepare(
  'DELETE FROM channel_members WHERE channel_id = ?',
)
const deleteAllChannelReads = db.prepare(
  'DELETE FROM channel_reads WHERE channel_id = ?',
)
const deleteAllChannelMessages = db.prepare(
  'DELETE FROM channel_messages WHERE channel_id = ?',
)
const deleteChannelRecord = db.prepare('DELETE FROM channels WHERE id = ?')
const getChannelMembers = db.prepare(`
  SELECT
    users.id,
    users.username,
    users.display_name AS displayName
  FROM channel_members
  JOIN users ON users.id = channel_members.user_id
  WHERE channel_members.channel_id = ?
  ORDER BY users.display_name ASC
`)
const getChannelMemberIds = db.prepare(
  'SELECT user_id AS userId FROM channel_members WHERE channel_id = ? ORDER BY user_id ASC',
)
const getChannelMessages = db.prepare(`
  SELECT
    channel_messages.id,
    channel_messages.channel_id AS channelId,
    channel_messages.sender_id AS senderId,
    users.display_name AS senderName,
    channel_messages.body,
    channel_messages.attachment_name AS attachmentName,
    channel_messages.attachment_path AS attachmentPath,
    channel_messages.attachment_size AS attachmentSize,
    channel_messages.deleted_at AS deletedAt,
    channel_messages.created_at AS createdAt
  FROM channel_messages
  JOIN users ON users.id = channel_messages.sender_id
  WHERE channel_messages.channel_id = ?
  ORDER BY channel_messages.created_at ASC, channel_messages.id ASC
`)
const insertChannelMessage = db.prepare(`
  INSERT INTO channel_messages (
    channel_id,
    sender_id,
    body,
    attachment_name,
    attachment_path,
    attachment_size
  ) VALUES (?, ?, ?, ?, ?, ?)
`)
const getLatestChannelMessage = db.prepare(`
  SELECT
    id,
    sender_id AS senderId,
    body,
    attachment_name AS attachmentName,
    deleted_at AS deletedAt,
    created_at AS createdAt
  FROM channel_messages
  WHERE channel_id = ?
  ORDER BY created_at DESC, id DESC
  LIMIT 1
`)
const getLatestChannelMessageId = db.prepare(`
  SELECT id
  FROM channel_messages
  WHERE channel_id = ?
  ORDER BY id DESC
  LIMIT 1
`)
const getDirectMessageByIdForSender = db.prepare(`
  SELECT
    messages.id,
    messages.conversation_id AS conversationId,
    messages.sender_id AS senderId,
    messages.deleted_at AS deletedAt,
    conversations.user_one_id AS userOneId,
    conversations.user_two_id AS userTwoId
  FROM messages
  JOIN conversations ON conversations.id = messages.conversation_id
  WHERE messages.id = ? AND messages.sender_id = ?
`)
const getChannelMessageByIdForSender = db.prepare(`
  SELECT
    channel_messages.id,
    channel_messages.channel_id AS channelId,
    channel_messages.sender_id AS senderId,
    channel_messages.deleted_at AS deletedAt,
    channels.name AS channelName
  FROM channel_messages
  JOIN channels ON channels.id = channel_messages.channel_id
  WHERE channel_messages.id = ? AND channel_messages.sender_id = ?
`)
const recallDirectMessageStatement = db.prepare(`
  UPDATE messages
  SET
    body = NULL,
    attachment_name = NULL,
    attachment_path = NULL,
    attachment_size = NULL,
    deleted_at = CURRENT_TIMESTAMP
  WHERE id = ?
`)
const recallChannelMessageStatement = db.prepare(`
  UPDATE channel_messages
  SET
    body = NULL,
    attachment_name = NULL,
    attachment_path = NULL,
    attachment_size = NULL,
    deleted_at = CURRENT_TIMESTAMP
  WHERE id = ?
`)
const getUnreadChannelCount = db.prepare(`
  SELECT COUNT(*) AS count
  FROM channel_messages
  WHERE channel_id = ?
    AND sender_id != ?
    AND deleted_at IS NULL
    AND id > COALESCE((
      SELECT last_read_message_id
      FROM channel_reads
      WHERE channel_id = ? AND user_id = ?
    ), 0)
`)
const upsertChannelRead = db.prepare(`
  INSERT INTO channel_reads (channel_id, user_id, last_read_message_id, updated_at)
  VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(channel_id, user_id)
  DO UPDATE SET
    last_read_message_id = excluded.last_read_message_id,
    updated_at = CURRENT_TIMESTAMP
`)
const searchChannelMessages = db.prepare(`
  SELECT
    channel_messages.id AS messageId,
    channels.id AS channelId,
    channels.name AS threadName,
    users.display_name AS senderName,
    channel_messages.sender_id AS senderId,
    channel_messages.body,
    channel_messages.attachment_name AS attachmentName,
    channel_messages.attachment_path AS attachmentPath,
    channel_messages.attachment_size AS attachmentSize,
    channel_messages.created_at AS createdAt
  FROM channel_messages
  JOIN channels ON channels.id = channel_messages.channel_id
  JOIN channel_members ON channel_members.channel_id = channels.id
  JOIN users ON users.id = channel_messages.sender_id
  WHERE
    channel_members.user_id = ?
    AND channel_messages.deleted_at IS NULL
    AND (
      COALESCE(channel_messages.body, '') LIKE ?
      OR COALESCE(channel_messages.attachment_name, '') LIKE ?
    )
  ORDER BY channel_messages.created_at DESC, channel_messages.id DESC
  LIMIT 20
`)

const createChannelWithMembers = db.transaction((name, creatorId, memberIds) => {
  const channelId = Number(insertChannel.run(name, creatorId).lastInsertRowid)
  const uniqueMemberIds = Array.from(new Set([creatorId, ...memberIds]))

  for (const memberId of uniqueMemberIds) {
    insertChannelMember.run(channelId, memberId)
  }

  return channelId
})

const removeChannelCompletely = db.transaction((channelId) => {
  deleteAllChannelReads.run(channelId)
  deleteAllChannelMessages.run(channelId)
  deleteAllChannelMembers.run(channelId)
  deleteChannelRecord.run(channelId)
})

function buildFileUrl(req, attachmentPath) {
  if (!attachmentPath) {
    return null
  }

  const normalizedPath = attachmentPath.startsWith('/')
    ? attachmentPath
    : `/${attachmentPath}`

  return `${req.protocol}://${req.get('host')}${normalizedPath}`
}

function sanitizeDirectMessage(req, message, recipientId) {
  return {
    ...message,
    conversationType: 'direct',
    recipientId,
    attachmentUrl: buildFileUrl(req, message.attachmentPath),
  }
}

function sanitizeChannelMessage(req, message, channelName) {
  return {
    ...message,
    conversationType: 'channel',
    channelName,
    attachmentUrl: buildFileUrl(req, message.attachmentPath),
  }
}

function normalizeUserPair(firstUserId, secondUserId) {
  return firstUserId < secondUserId
    ? [firstUserId, secondUserId]
    : [secondUserId, firstUserId]
}

function getOrCreateConversation(userId, otherUserId) {
  const [userOneId, userTwoId] = normalizeUserPair(userId, otherUserId)
  let conversation = getConversationByUsers.get(userOneId, userTwoId)

  if (!conversation) {
    const insertResult = insertConversation.run(userOneId, userTwoId)
    conversation = getConversationByUsers.get(userOneId, userTwoId)

    if (!conversation && insertResult.lastInsertRowid) {
      conversation = {
        id: Number(insertResult.lastInsertRowid),
        user_one_id: userOneId,
        user_two_id: userTwoId,
      }
    }
  }

  return conversation
}

function buildContactList(req, userId) {
  return getAllOtherUsers.all(userId).map((user) => {
    const conversation = getConversationByUsers.get(
      ...normalizeUserPair(userId, user.id),
    )
    const latestMessage = conversation
      ? getLatestDirectMessage.get(conversation.id)
      : null

    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      conversationId: conversation?.id ?? null,
      unreadCount: conversation
        ? getUnreadDirectCount.get(conversation.id, userId, conversation.id, userId).count
        : 0,
      lastMessage: latestMessage
        ? {
            senderId: latestMessage.senderId,
            body: latestMessage.body,
            attachmentName: latestMessage.attachmentName,
            deletedAt: latestMessage.deletedAt,
            createdAt: latestMessage.createdAt,
          }
        : null,
    }
  })
}

function buildChannelSummary(req, channelId) {
  const channel = getChannelById.get(channelId)
  const members = getChannelMembers.all(channelId)
  const latestMessage = getLatestChannelMessage.get(channelId)

  return {
    id: channel.id,
    name: channel.name,
    createdBy: channel.createdBy,
    createdAt: channel.createdAt,
    members,
    memberCount: members.length,
    lastMessage: latestMessage
      ? {
          senderId: latestMessage.senderId,
          body: latestMessage.body,
          attachmentName: latestMessage.attachmentName,
          deletedAt: latestMessage.deletedAt,
          createdAt: latestMessage.createdAt,
        }
      : null,
  }
}

function buildChannelList(req, userId) {
  return getChannelsForUser.all(userId).map((channel) => ({
    ...buildChannelSummary(req, channel.id),
    unreadCount: getUnreadChannelCount.get(channel.id, userId, channel.id, userId).count,
  }))
}

function buildSearchResults(req, userId, query) {
  const likeQuery = `%${query}%`
  const directMatches = searchDirectMessages
    .all(userId, userId, userId, likeQuery, likeQuery)
    .map((message) => ({
      id: `direct-${message.messageId}`,
      messageId: message.messageId,
      conversationType: 'direct',
      threadId: message.peerId,
      threadName: message.threadName,
      senderId: message.senderId,
      senderName: message.senderName,
      body: message.body,
      attachmentName: message.attachmentName,
      attachmentPath: message.attachmentPath,
      attachmentSize: message.attachmentSize,
      attachmentUrl: buildFileUrl(req, message.attachmentPath),
      createdAt: message.createdAt,
    }))
  const channelMatches = searchChannelMessages
    .all(userId, likeQuery, likeQuery)
    .map((message) => ({
      id: `channel-${message.messageId}`,
      messageId: message.messageId,
      conversationType: 'channel',
      threadId: message.channelId,
      threadName: message.threadName,
      senderId: message.senderId,
      senderName: message.senderName,
      body: message.body,
      attachmentName: message.attachmentName,
      attachmentPath: message.attachmentPath,
      attachmentSize: message.attachmentSize,
      attachmentUrl: buildFileUrl(req, message.attachmentPath),
      createdAt: message.createdAt,
    }))

  return [...directMatches, ...channelMatches]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 20)
}

function buildAdminOverview() {
  return {
    userCount: getAllUsers.all().length,
    adminCount: countAdmins.get().count,
    channelCount: countChannels.get().count,
    messageCount: countMessages.get().count,
    todayMessageCount: countTodayMessages.get().count,
  }
}

function buildAdminChannels(req) {
  return db.prepare('SELECT id FROM channels ORDER BY created_at DESC').all().map((channel) => ({
    ...buildChannelSummary(req, channel.id),
  }))
}

function addChannelMember(req, res, channelId, memberId) {
  if (Number.isNaN(channelId) || Number.isNaN(memberId)) {
    res.status(400).json({ message: '参数无效。' })
    return
  }

  const channel = getChannelById.get(channelId)

  if (!channel) {
    res.status(404).json({ message: '频道不存在。' })
    return
  }

  if (channel.createdBy !== req.user.id) {
    res.status(403).json({ message: '只有频道创建者可以管理成员。' })
    return
  }

  const user = getUserById.get(memberId)

  if (!user) {
    res.status(404).json({ message: '目标成员不存在。' })
    return
  }

  if (getChannelMemberRecord.get(channelId, memberId)) {
    res.status(400).json({ message: '该成员已在群聊中。' })
    return
  }

  insertChannelMember.run(channelId, memberId)
  const summary = {
    ...buildChannelSummary(req, channelId),
    unreadCount: 0,
  }
  const memberIds = summary.members.map((member) => member.id)

  emitToUserRooms('channel:updated', summary, memberIds)
  emitToUserRooms('channel:new', summary, [memberId])

  res.json({ channel: summary })
}

function removeChannelMember(req, res, channelId, memberId) {
  if (Number.isNaN(channelId) || Number.isNaN(memberId)) {
    res.status(400).json({ message: '参数无效。' })
    return
  }

  const channel = getChannelById.get(channelId)

  if (!channel) {
    res.status(404).json({ message: '频道不存在。' })
    return
  }

  if (channel.createdBy !== req.user.id) {
    res.status(403).json({ message: '只有频道创建者可以管理成员。' })
    return
  }

  if (memberId === channel.createdBy) {
    res.status(400).json({ message: '不能移除频道创建者。' })
    return
  }

  if (!getChannelMemberRecord.get(channelId, memberId)) {
    res.status(404).json({ message: '该成员不在群聊中。' })
    return
  }

  deleteChannelMember.run(channelId, memberId)
  deleteChannelRead.run(channelId, memberId)

  const summary = {
    ...buildChannelSummary(req, channelId),
    unreadCount: 0,
  }
  const remainingMemberIds = summary.members.map((member) => member.id)

  emitToUserRooms('channel:updated', summary, remainingMemberIds)
  emitToUserRooms(
    'channel:removed',
    {
      channelId,
    },
    [memberId],
  )

  res.json({ channel: summary })
}

function recallDirectMessage(req, res, messageId) {
  if (Number.isNaN(messageId)) {
    res.status(400).json({ message: '消息参数无效。' })
    return
  }

  const message = getDirectMessageByIdForSender.get(messageId, req.user.id)

  if (!message) {
    res.status(404).json({ message: '消息不存在，或你无权撤回。' })
    return
  }

  if (message.deletedAt) {
    res.status(400).json({ message: '该消息已撤回。' })
    return
  }

  recallDirectMessageStatement.run(messageId)

  const otherUserId =
    message.userOneId === req.user.id ? message.userTwoId : message.userOneId
  const recalledMessage = getDirectMessagesForConversation
    .all(message.conversationId)
    .find((item) => item.id === messageId)
  const payload = sanitizeDirectMessage(req, recalledMessage, otherUserId)

  emitToUserRooms('message:recalled', payload, [req.user.id, otherUserId])

  res.json({ message: payload })
}

function recallChannelMessage(req, res, messageId) {
  if (Number.isNaN(messageId)) {
    res.status(400).json({ message: '消息参数无效。' })
    return
  }

  const message = getChannelMessageByIdForSender.get(messageId, req.user.id)

  if (!message) {
    res.status(404).json({ message: '消息不存在，或你无权撤回。' })
    return
  }

  if (message.deletedAt) {
    res.status(400).json({ message: '该消息已撤回。' })
    return
  }

  recallChannelMessageStatement.run(messageId)

  const recalledMessage = getChannelMessages
    .all(message.channelId)
    .find((item) => item.id === messageId)
  const payload = sanitizeChannelMessage(req, recalledMessage, message.channelName)
  const memberIds = getChannelMemberIds.all(message.channelId).map((member) => member.userId)

  emitToUserRooms('message:recalled', payload, memberIds)

  res.json({ message: payload })
}

function createToken(user) {
  return jwt.sign(
    {
      userId: user.id,
    },
    JWT_SECRET,
    { expiresIn: '7d' },
  )
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ message: '未登录或登录已失效。' })
    return
  }

  try {
    const token = authHeader.replace('Bearer ', '')
    const payload = jwt.verify(token, JWT_SECRET)
    const user = getUserById.get(payload.userId)

    if (!user) {
      res.status(401).json({ message: '用户不存在。' })
      return
    }

    req.user = user
    next()
  } catch {
    res.status(401).json({ message: '令牌校验失败。' })
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ message: '仅管理员可访问该功能。' })
    return
  }

  next()
}

function emitToUserRooms(eventName, payload, userIds) {
  userIds.forEach((userId) => {
    io.to(`user:${userId}`).emit(eventName, payload)
  })
}

function markDirectThreadRead(userId, conversationId) {
  const latestMessage = getLatestDirectMessageId.get(conversationId)
  upsertDirectRead.run(conversationId, userId, latestMessage?.id ?? 0)
}

function markChannelThreadRead(userId, channelId) {
  const latestMessage = getLatestChannelMessageId.get(channelId)
  upsertChannelRead.run(channelId, userId, latestMessage?.id ?? 0)
}

function createDirectMessage(req, res, otherUserId, content) {
  if (Number.isNaN(otherUserId)) {
    res.status(400).json({ message: '用户参数无效。' })
    return
  }

  const trimmedBody = typeof content.body === 'string' ? content.body.trim() : ''

  if (!trimmedBody && !content.attachmentName) {
    res.status(400).json({ message: '消息内容不能为空。' })
    return
  }

  const otherUser = getUserById.get(otherUserId)

  if (!otherUser) {
    res.status(404).json({ message: '目标用户不存在。' })
    return
  }

  if (otherUser.id === req.user.id) {
    res.status(400).json({ message: '不能给自己发送消息。' })
    return
  }

  const conversation = getOrCreateConversation(req.user.id, otherUser.id)
  const insertResult = insertDirectMessage.run(
    conversation.id,
    req.user.id,
    trimmedBody || null,
    content.attachmentName || null,
    content.attachmentPath || null,
    content.attachmentSize || null,
  )

  const insertedMessage = getDirectMessagesForConversation
    .all(conversation.id)
    .find((message) => message.id === Number(insertResult.lastInsertRowid))

  const payload = sanitizeDirectMessage(req, insertedMessage, otherUser.id)
  emitToUserRooms('message:new', payload, [req.user.id, otherUser.id])

  res.status(201).json({
    conversationId: conversation.id,
    message: payload,
  })
}

function createChannelMessage(req, res, channelId, content) {
  if (Number.isNaN(channelId)) {
    res.status(400).json({ message: '频道参数无效。' })
    return
  }

  const trimmedBody = typeof content.body === 'string' ? content.body.trim() : ''

  if (!trimmedBody && !content.attachmentName) {
    res.status(400).json({ message: '消息内容不能为空。' })
    return
  }

  const channel = getChannelByIdForUser.get(channelId, req.user.id)

  if (!channel) {
    res.status(404).json({ message: '频道不存在或你没有访问权限。' })
    return
  }

  const insertResult = insertChannelMessage.run(
    channelId,
    req.user.id,
    trimmedBody || null,
    content.attachmentName || null,
    content.attachmentPath || null,
    content.attachmentSize || null,
  )

  const insertedMessage = getChannelMessages
    .all(channelId)
    .find((message) => message.id === Number(insertResult.lastInsertRowid))
  const payload = sanitizeChannelMessage(req, insertedMessage, channel.name)
  const memberIds = getChannelMemberIds.all(channelId).map((member) => member.userId)

  emitToUserRooms('message:new', payload, memberIds)

  res.status(201).json({
    channelId,
    message: payload,
  })
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/auth/login', (req, res) => {
  const username = `${req.body?.username || ''}`.trim()
  const password = `${req.body?.password || ''}`.trim()

  if (!username || !password) {
    res.status(400).json({ message: '请输入账号和密码。' })
    return
  }

  const user = getUserByUsername.get(username)

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401).json({ message: '账号或密码错误。' })
    return
  }

  const authUser = {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
  }

  res.json({
    token: createToken(authUser),
    user: authUser,
  })
})

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user })
})

app.get('/api/admin/overview', requireAuth, requireAdmin, (req, res) => {
  res.json({
    overview: buildAdminOverview(),
  })
})

app.get('/api/admin/users', requireAuth, requireAdmin, (_req, res) => {
  res.json({
    users: getAllUsers.all(),
  })
})

app.patch('/api/admin/users/:userId/role', requireAuth, requireAdmin, (req, res) => {
  const userId = Number(req.params.userId)
  const nextRole = `${req.body?.role || ''}`.trim()

  if (Number.isNaN(userId) || !['admin', 'member'].includes(nextRole)) {
    res.status(400).json({ message: '角色参数无效。' })
    return
  }

  const user = getUserById.get(userId)

  if (!user) {
    res.status(404).json({ message: '用户不存在。' })
    return
  }

  updateUserRole.run(nextRole, userId)
  res.json({
    user: getUserById.get(userId),
  })
})

app.get('/api/admin/channels', requireAuth, requireAdmin, (req, res) => {
  res.json({
    channels: buildAdminChannels(req),
  })
})

app.delete('/api/admin/channels/:channelId', requireAuth, requireAdmin, (req, res) => {
  const channelId = Number(req.params.channelId)

  if (Number.isNaN(channelId)) {
    res.status(400).json({ message: '频道参数无效。' })
    return
  }

  const channel = getChannelById.get(channelId)

  if (!channel) {
    res.status(404).json({ message: '频道不存在。' })
    return
  }

  const memberIds = getChannelMemberIds.all(channelId).map((member) => member.userId)
  removeChannelCompletely(channelId)
  emitToUserRooms('channel:removed', { channelId }, memberIds)

  res.json({ ok: true })
})

app.get('/api/users', requireAuth, (req, res) => {
  res.json({ users: buildContactList(req, req.user.id) })
})

app.get('/api/channels', requireAuth, (req, res) => {
  res.json({ channels: buildChannelList(req, req.user.id) })
})

app.get('/api/channel-candidates', requireAuth, (req, res) => {
  res.json({
    users: getAllOtherUsers.all(req.user.id),
  })
})

app.get('/api/search/messages', requireAuth, (req, res) => {
  const query = `${req.query.q || ''}`.trim()

  if (query.length < 2) {
    res.json({ results: [] })
    return
  }

  res.json({
    results: buildSearchResults(req, req.user.id, query),
  })
})

app.post('/api/channels', requireAuth, (req, res) => {
  const name = `${req.body?.name || ''}`.trim()
  const requestedMemberIds = Array.isArray(req.body?.memberIds)
    ? req.body.memberIds.map((memberId) => Number(memberId)).filter((memberId) => !Number.isNaN(memberId))
    : []

  if (!name) {
    res.status(400).json({ message: '请输入群聊名称。' })
    return
  }

  if (requestedMemberIds.length === 0) {
    res.status(400).json({ message: '至少选择一位群成员。' })
    return
  }

  const allowedUserIds = new Set(getAllUsers.all().map((user) => user.id))
  const filteredMemberIds = requestedMemberIds.filter(
    (memberId) => memberId !== req.user.id && allowedUserIds.has(memberId),
  )

  if (filteredMemberIds.length === 0) {
    res.status(400).json({ message: '所选成员无效。' })
    return
  }

  const channelId = createChannelWithMembers(name, req.user.id, filteredMemberIds)
  const channel = {
    ...buildChannelSummary(req, channelId),
    unreadCount: 0,
  }
  const memberIds = channel.members.map((member) => member.id)

  emitToUserRooms('channel:new', channel, memberIds)

  res.status(201).json({ channel })
})

app.post('/api/channels/:channelId/members', requireAuth, (req, res) => {
  addChannelMember(req, res, Number(req.params.channelId), Number(req.body?.memberId))
})

app.delete('/api/channels/:channelId/members/:memberId', requireAuth, (req, res) => {
  removeChannelMember(req, res, Number(req.params.channelId), Number(req.params.memberId))
})

app.get('/api/chat/direct/:userId/messages', requireAuth, (req, res) => {
  const otherUserId = Number(req.params.userId)

  if (Number.isNaN(otherUserId)) {
    res.status(400).json({ message: '用户参数无效。' })
    return
  }

  const conversation = getConversationByUsers.get(
    ...normalizeUserPair(req.user.id, otherUserId),
  )

  if (!conversation) {
    res.json({ conversationId: null, messages: [] })
    return
  }

  const messages = getDirectMessagesForConversation
    .all(conversation.id)
    .map((message) => sanitizeDirectMessage(req, message, otherUserId))

  res.json({
    conversationId: conversation.id,
    messages,
  })
})

app.get('/api/channels/:channelId/messages', requireAuth, (req, res) => {
  const channelId = Number(req.params.channelId)
  const channel = getChannelByIdForUser.get(channelId, req.user.id)

  if (!channel) {
    res.status(404).json({ message: '频道不存在或你没有访问权限。' })
    return
  }

  const messages = getChannelMessages
    .all(channelId)
    .map((message) => sanitizeChannelMessage(req, message, channel.name))

  res.json({
    channelId,
    messages,
  })
})

app.post('/api/chat/direct/:userId/read', requireAuth, (req, res) => {
  const otherUserId = Number(req.params.userId)

  if (Number.isNaN(otherUserId)) {
    res.status(400).json({ message: '用户参数无效。' })
    return
  }

  const conversation = getConversationByUsers.get(
    ...normalizeUserPair(req.user.id, otherUserId),
  )

  if (!conversation) {
    res.json({ unreadCount: 0 })
    return
  }

  markDirectThreadRead(req.user.id, conversation.id)
  res.json({ unreadCount: 0 })
})

app.post('/api/channels/:channelId/read', requireAuth, (req, res) => {
  const channelId = Number(req.params.channelId)
  const channel = getChannelByIdForUser.get(channelId, req.user.id)

  if (!channel) {
    res.status(404).json({ message: '频道不存在或你没有访问权限。' })
    return
  }

  markChannelThreadRead(req.user.id, channelId)
  res.json({ unreadCount: 0 })
})

app.post('/api/chat/direct/:userId/messages', requireAuth, (req, res) => {
  createDirectMessage(req, res, Number(req.params.userId), {
    body: req.body?.body,
  })
})

app.delete('/api/chat/direct/messages/:messageId', requireAuth, (req, res) => {
  recallDirectMessage(req, res, Number(req.params.messageId))
})

app.post('/api/channels/:channelId/messages', requireAuth, (req, res) => {
  createChannelMessage(req, res, Number(req.params.channelId), {
    body: req.body?.body,
  })
})

app.delete('/api/channels/messages/:messageId', requireAuth, (req, res) => {
  recallChannelMessage(req, res, Number(req.params.messageId))
})

app.post(
  '/api/chat/direct/:userId/attachments',
  requireAuth,
  upload.single('file'),
  (req, res) => {
    createDirectMessage(req, res, Number(req.params.userId), {
      body: req.body?.body,
      attachmentName: req.file?.originalname,
      attachmentPath: req.file ? `/uploads/${req.file.filename}` : null,
      attachmentSize: req.file?.size || null,
    })
  },
)

app.post(
  '/api/channels/:channelId/attachments',
  requireAuth,
  upload.single('file'),
  (req, res) => {
    createChannelMessage(req, res, Number(req.params.channelId), {
      body: req.body?.body,
      attachmentName: req.file?.originalname,
      attachmentPath: req.file ? `/uploads/${req.file.filename}` : null,
      attachmentSize: req.file?.size || null,
    })
  },
)

io.use((socket, next) => {
  const token = socket.handshake.auth?.token

  if (!token) {
    next(new Error('missing token'))
    return
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET)
    const user = getUserById.get(payload.userId)

    if (!user) {
      next(new Error('user not found'))
      return
    }

    socket.user = user
    next()
  } catch {
    next(new Error('invalid token'))
  }
})

io.on('connection', (socket) => {
  socket.join(`user:${socket.user.id}`)
})

httpServer.listen(PORT, () => {
  console.log(`Chat backend listening on http://localhost:${PORT}`)
})
