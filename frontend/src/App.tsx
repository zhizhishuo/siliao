import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, Dispatch, FormEvent, SetStateAction } from 'react'
import {
  Bell,
  Crown,
  Hash,
  LayoutDashboard,
  MessageCircle,
  MessageSquareText,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Upload,
  Users,
  UserRoundPlus,
} from 'lucide-react'
import { io, Socket } from 'socket.io-client'
import './App.css'

type AuthUser = {
  id: number
  username: string
  displayName: string
  role: 'admin' | 'member'
}

type MessagePreview = {
  senderId: number
  body: string | null
  attachmentName: string | null
  deletedAt?: string | null
  createdAt: string
}

type DirectContact = {
  id: number
  username: string
  displayName: string
  conversationId: number | null
  unreadCount: number
  lastMessage: MessagePreview | null
}

type ChannelMember = {
  id: number
  username: string
  displayName: string
}

type Channel = {
  id: number
  name: string
  createdBy: number
  members: ChannelMember[]
  memberCount: number
  unreadCount: number
  lastMessage: MessagePreview | null
}

type ThreadSelection =
  | { type: 'channel'; id: number }
  | { type: 'direct'; id: number }

type Message = {
  id: number
  conversationType: 'channel' | 'direct'
  conversationId?: number
  channelId?: number
  channelName?: string
  senderId: number
  senderName: string
  recipientId?: number
  body: string | null
  attachmentName: string | null
  attachmentPath: string | null
  attachmentSize: number | null
  attachmentUrl: string | null
  deletedAt?: string | null
  createdAt: string
}

type SearchResult = {
  id: string
  messageId: number
  conversationType: 'channel' | 'direct'
  threadId: number
  threadName: string
  senderId: number
  senderName: string
  body: string | null
  attachmentName: string | null
  attachmentPath: string | null
  attachmentSize: number | null
  attachmentUrl: string | null
  createdAt: string
}

type NotificationItem = {
  id: string
  thread: ThreadSelection
  title: string
  subtitle: string
  unreadCount: number
  lastTime: string | null
}

type AdminOverview = {
  userCount: number
  adminCount: number
  channelCount: number
  messageCount: number
  todayMessageCount: number
}

const API_BASE = import.meta.env.VITE_API_BASE || ''
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001'
const TOKEN_KEY = 'team-chat-token'

const demoAccounts = [
  { username: 'li.lei', displayName: '李雷', password: 'password123' },
  { username: 'han.mei', displayName: '韩梅梅', password: 'password123' },
  { username: 'wang.wei', displayName: '王伟', password: 'password123' },
]

function formatTime(dateString: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(dateString))
}

function formatSize(size: number | null) {
  if (!size) {
    return ''
  }

  if (size < 1024) {
    return `${size} B`
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function buildPreview(lastMessage: MessagePreview | null) {
  if (!lastMessage) {
    return '还没有消息，发一句打个招呼吧。'
  }

  if (lastMessage.deletedAt) {
    return '该消息已撤回'
  }

  if (lastMessage.attachmentName && lastMessage.body) {
    return `[文件] ${lastMessage.attachmentName} · ${lastMessage.body}`
  }

  if (lastMessage.attachmentName) {
    return `[文件] ${lastMessage.attachmentName}`
  }

  return lastMessage.body || '新消息'
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  token?: string | null,
): Promise<T> {
  const headers = new Headers(options.headers)
  const isFormData = options.body instanceof FormData

  if (!isFormData) {
    headers.set('Content-Type', 'application/json')
  }

  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  })

  const payload = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(payload.message || '请求失败')
  }

  return payload as T
}

function sortByLastMessage<T extends { lastMessage: MessagePreview | null }>(
  items: T[],
  getName: (item: T) => string,
) {
  return [...items].sort((left, right) => {
    const leftTime = left.lastMessage?.createdAt || ''
    const rightTime = right.lastMessage?.createdAt || ''
    return rightTime.localeCompare(leftTime) || getName(left).localeCompare(getName(right))
  })
}

function getInitialThread(channels: Channel[], contacts: DirectContact[]) {
  if (channels[0]) {
    return { type: 'channel' as const, id: channels[0].id }
  }

  if (contacts[0]) {
    return { type: 'direct' as const, id: contacts[0].id }
  }

  return null
}

function upsertChannel(channels: Channel[], nextChannel: Channel) {
  const updated = channels.some((channel) => channel.id === nextChannel.id)
    ? channels.map((channel) => (channel.id === nextChannel.id ? nextChannel : channel))
    : [...channels, nextChannel]

  return sortByLastMessage(updated, (channel) => channel.name)
}

function resetUnreadForThread(
  thread: ThreadSelection,
  setContacts: Dispatch<SetStateAction<DirectContact[]>>,
  setChannels: Dispatch<SetStateAction<Channel[]>>,
) {
  if (thread.type === 'direct') {
    setContacts((prev) =>
      prev.map((contact) =>
        contact.id === thread.id ? { ...contact, unreadCount: 0 } : contact,
      ),
    )
    return
  }

  setChannels((prev) =>
    prev.map((channel) =>
      channel.id === thread.id ? { ...channel, unreadCount: 0 } : channel,
    ),
  )
}

function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)
  const [contacts, setContacts] = useState<DirectContact[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [activeThread, setActiveThread] = useState<ThreadSelection | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [messageBody, setMessageBody] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [loginForm, setLoginForm] = useState({ username: '', password: '' })
  const [newChannelName, setNewChannelName] = useState('')
  const [selectedChannelMembers, setSelectedChannelMembers] = useState<number[]>([])
  const [showCreateChannel, setShowCreateChannel] = useState(false)
  const [showMemberManager, setShowMemberManager] = useState(false)
  const [showAdminConsole, setShowAdminConsole] = useState(false)
  const [loadingApp, setLoadingApp] = useState(Boolean(token))
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [connectionText, setConnectionText] = useState('未连接')
  const [highlightedMessageId, setHighlightedMessageId] = useState<number | null>(null)
  const [adminOverview, setAdminOverview] = useState<AdminOverview | null>(null)
  const [adminUsers, setAdminUsers] = useState<AuthUser[]>([])
  const [adminChannels, setAdminChannels] = useState<Channel[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const socketRef = useRef<Socket | null>(null)
  const messageEndRef = useRef<HTMLDivElement | null>(null)

  const activeChannel = useMemo(
    () =>
      activeThread?.type === 'channel'
        ? channels.find((channel) => channel.id === activeThread.id) || null
        : null,
    [activeThread, channels],
  )
  const activeContact = useMemo(
    () =>
      activeThread?.type === 'direct'
        ? contacts.find((contact) => contact.id === activeThread.id) || null
        : null,
    [activeThread, contacts],
  )
  const notificationItems = useMemo<NotificationItem[]>(() => {
    const channelItems = channels
      .filter((channel) => channel.unreadCount > 0)
      .map((channel) => ({
        id: `channel-${channel.id}`,
        thread: { type: 'channel' as const, id: channel.id },
        title: channel.name,
        subtitle: `群聊 · ${buildPreview(channel.lastMessage)}`,
        unreadCount: channel.unreadCount,
        lastTime: channel.lastMessage?.createdAt ?? null,
      }))

    const contactItems = contacts
      .filter((contact) => contact.unreadCount > 0)
      .map((contact) => ({
        id: `direct-${contact.id}`,
        thread: { type: 'direct' as const, id: contact.id },
        title: contact.displayName,
        subtitle: `私聊 · ${buildPreview(contact.lastMessage)}`,
        unreadCount: contact.unreadCount,
        lastTime: contact.lastMessage?.createdAt ?? null,
      }))

    return [...channelItems, ...contactItems].sort((left, right) =>
      (right.lastTime || '').localeCompare(left.lastTime || ''),
    )
  }, [channels, contacts])
  const totalUnread = useMemo(
    () => notificationItems.reduce((sum, item) => sum + item.unreadCount, 0),
    [notificationItems],
  )
  const availableMembersForActiveChannel = useMemo(() => {
    if (!activeChannel) {
      return []
    }

    const memberIds = new Set(activeChannel.members.map((member) => member.id))
    return contacts.filter((contact) => !memberIds.has(contact.id))
  }, [activeChannel, contacts])
  const canManageActiveChannel =
    Boolean(activeChannel) && Boolean(currentUser) && activeChannel?.createdBy === currentUser?.id
  const sendDisabled = submitting || !activeThread || !messageBody.trim()

  async function refreshLists(authToken: string, preserveSelection = true) {
    const [{ users }, { channels: nextChannels }] = await Promise.all([
      request<{ users: DirectContact[] }>('/api/users', {}, authToken),
      request<{ channels: Channel[] }>('/api/channels', {}, authToken),
    ])

    const sortedContacts = sortByLastMessage(users, (contact) => contact.displayName)
    const sortedChannels = sortByLastMessage(nextChannels, (channel) => channel.name)

    setContacts(sortedContacts)
    setChannels(sortedChannels)
    setActiveThread((current) => {
      if (!preserveSelection || !current) {
        return getInitialThread(sortedChannels, sortedContacts)
      }

      const exists =
        current.type === 'channel'
          ? sortedChannels.some((channel) => channel.id === current.id)
          : sortedContacts.some((contact) => contact.id === current.id)

      return exists ? current : getInitialThread(sortedChannels, sortedContacts)
    })
  }

  async function markThreadAsRead(thread: ThreadSelection, authToken: string) {
    const path =
      thread.type === 'channel'
        ? `/api/channels/${thread.id}/read`
        : `/api/chat/direct/${thread.id}/read`

    await request<{ unreadCount: number }>(
      path,
      {
        method: 'POST',
      },
      authToken,
    )

    resetUnreadForThread(thread, setContacts, setChannels)
  }

  async function refreshAdminData(authToken: string) {
    const [{ overview }, { users }, { channels: nextChannels }] = await Promise.all([
      request<{ overview: AdminOverview }>('/api/admin/overview', {}, authToken),
      request<{ users: AuthUser[] }>('/api/admin/users', {}, authToken),
      request<{ channels: Channel[] }>('/api/admin/channels', {}, authToken),
    ])

    setAdminOverview(overview)
    setAdminUsers(users)
    setAdminChannels(nextChannels)
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY)
    setToken(null)
    setCurrentUser(null)
    setContacts([])
    setChannels([])
    setMessages([])
    setActiveThread(null)
    setShowCreateChannel(false)
    setShowMemberManager(false)
    setShowAdminConsole(false)
    setSelectedChannelMembers([])
    setNewChannelName('')
    setAdminOverview(null)
    setAdminUsers([])
    setAdminChannels([])
    socketRef.current?.disconnect()
  }

  useEffect(() => {
    if (!token) {
      setCurrentUser(null)
      setLoadingApp(false)
      return
    }

    let cancelled = false

    async function bootstrap() {
      try {
        setLoadingApp(true)
        const { user } = await request<{ user: AuthUser }>('/api/auth/me', {}, token)

        if (cancelled) {
          return
        }

        setCurrentUser(user)
        await refreshLists(token!, false)
        if (user.role === 'admin') {
          await refreshAdminData(token!)
        }
        setError('')
      } catch (requestError) {
        logout()
        setError(requestError instanceof Error ? requestError.message : '初始化失败')
      } finally {
        if (!cancelled) {
          setLoadingApp(false)
        }
      }
    }

    void bootstrap()

    return () => {
      cancelled = true
    }
  }, [token])

  useEffect(() => {
    if (!token || !currentUser) {
      socketRef.current?.disconnect()
      socketRef.current = null
      return
    }

    const socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket'],
    })

    socketRef.current = socket

    socket.on('connect', () => {
      setConnectionText('实时连接已建立')
    })

    socket.on('disconnect', () => {
      setConnectionText('实时连接已断开')
    })

    socket.on('connect_error', () => {
      setConnectionText('实时连接失败，正在重试')
    })

    socket.on('channel:new', (channel: Channel) => {
      setChannels((prev) => upsertChannel(prev, { ...channel, unreadCount: channel.unreadCount ?? 0 }))
    })

    socket.on('channel:updated', (channel: Channel) => {
      setChannels((prev) => upsertChannel(prev, { ...channel, unreadCount: channel.unreadCount ?? 0 }))
    })

    socket.on('channel:removed', ({ channelId }: { channelId: number }) => {
      setChannels((prev) => prev.filter((channel) => channel.id !== channelId))
      setActiveThread((current) =>
        current?.type === 'channel' && current.id === channelId ? null : current,
      )
    })

    socket.on('message:new', (message: Message) => {
      if (message.conversationType === 'direct') {
        const peerId =
          message.senderId === currentUser.id ? message.recipientId : message.senderId

        if (!peerId) {
          return
        }

        const isActiveThread =
          activeThread?.type === 'direct' && activeThread.id === peerId

        setContacts((prev) =>
          sortByLastMessage(
            prev.map((contact) =>
              contact.id === peerId
                ? {
                    ...contact,
                    conversationId: message.conversationId || contact.conversationId,
                    unreadCount:
                      message.senderId === currentUser.id || isActiveThread
                        ? 0
                        : contact.unreadCount + 1,
                    lastMessage: {
                      senderId: message.senderId,
                      body: message.body,
                      attachmentName: message.attachmentName,
                      createdAt: message.createdAt,
                    },
                  }
                : contact,
            ),
            (contact) => contact.displayName,
          ),
        )

        if (isActiveThread) {
          setMessages((prev) =>
            prev.some((item) => item.id === message.id) ? prev : [...prev, message],
          )

          if (message.senderId !== currentUser.id) {
            void markThreadAsRead({ type: 'direct', id: peerId }, token)
          }
        }

        return
      }

      if (!message.channelId) {
        return
      }

      const isActiveThread =
        activeThread?.type === 'channel' && activeThread.id === message.channelId

      setChannels((prev) =>
        sortByLastMessage(
          prev.map((channel) =>
            channel.id === message.channelId
              ? {
                  ...channel,
                  unreadCount:
                    message.senderId === currentUser.id || isActiveThread
                      ? 0
                      : channel.unreadCount + 1,
                  lastMessage: {
                    senderId: message.senderId,
                    body: message.body,
                    attachmentName: message.attachmentName,
                    createdAt: message.createdAt,
                  },
                }
              : channel,
          ),
          (channel) => channel.name,
        ),
      )

      if (isActiveThread) {
        setMessages((prev) =>
          prev.some((item) => item.id === message.id) ? prev : [...prev, message],
        )

        if (message.senderId !== currentUser.id) {
          void markThreadAsRead({ type: 'channel', id: message.channelId }, token)
        }
      }
    })

    socket.on('message:recalled', (message: Message) => {
      setSearchResults((prev) => prev.filter((result) => result.messageId !== message.id))

      if (message.conversationType === 'direct') {
        const peerId =
          message.senderId === currentUser.id ? message.recipientId : message.senderId

        if (!peerId) {
          return
        }

        setContacts((prev) =>
          sortByLastMessage(
            prev.map((contact) =>
              contact.id === peerId
                ? {
                    ...contact,
                    lastMessage:
                      contact.conversationId === message.conversationId
                        ? {
                            senderId: message.senderId,
                            body: message.body,
                            attachmentName: message.attachmentName,
                            deletedAt: message.deletedAt,
                            createdAt: message.createdAt,
                          }
                        : contact.lastMessage,
                  }
                : contact,
            ),
            (contact) => contact.displayName,
          ),
        )

        if (activeThread?.type === 'direct' && activeThread.id === peerId) {
          setMessages((prev) =>
            prev.map((item) => (item.id === message.id ? { ...item, ...message } : item)),
          )
        }

        void refreshLists(token)
        return
      }

      if (!message.channelId) {
        return
      }

      setChannels((prev) =>
        sortByLastMessage(
          prev.map((channel) =>
            channel.id === message.channelId
              ? {
                  ...channel,
                  lastMessage: {
                    senderId: message.senderId,
                    body: message.body,
                    attachmentName: message.attachmentName,
                    deletedAt: message.deletedAt,
                    createdAt: message.createdAt,
                  },
                }
              : channel,
          ),
          (channel) => channel.name,
        ),
      )

      if (activeThread?.type === 'channel' && activeThread.id === message.channelId) {
        setMessages((prev) =>
          prev.map((item) => (item.id === message.id ? { ...item, ...message } : item)),
        )
      }

      void refreshLists(token)
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [activeThread, currentUser, token])

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!highlightedMessageId) {
      return
    }

    const matchedNode = document.querySelector<HTMLElement>(
      `[data-message-id="${highlightedMessageId}"]`,
    )

    matchedNode?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [highlightedMessageId, messages])

  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) 团队聊天系统` : '团队聊天系统'
  }, [totalUnread])

  useEffect(() => {
    if (!token || !activeThread) {
      setMessages([])
      return
    }

    const currentThread = activeThread
    let cancelled = false

    async function loadMessages() {
      try {
        setLoadingMessages(true)
        const path =
          currentThread.type === 'channel'
            ? `/api/channels/${currentThread.id}/messages`
            : `/api/chat/direct/${currentThread.id}/messages`

        const payload = await request<{ messages: Message[] }>(path, {}, token)

        if (!cancelled) {
          setMessages(payload.messages)
          setError('')
          void markThreadAsRead(currentThread, token!)
        }
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : '读取消息失败')
        }
      } finally {
        if (!cancelled) {
          setLoadingMessages(false)
        }
      }
    }

    void loadMessages()

    return () => {
      cancelled = true
    }
  }, [activeThread, token])

  useEffect(() => {
    setShowMemberManager(false)
  }, [activeThread?.id, activeThread?.type])

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    try {
      setSubmitting(true)
      const payload = await request<{ token: string; user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(loginForm),
      })

      localStorage.setItem(TOKEN_KEY, payload.token)
      setToken(payload.token)
      setCurrentUser(payload.user)
      setError('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '登录失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!token || searchQuery.trim().length < 2) {
      setSearchResults([])
      return
    }

    try {
      setSearchLoading(true)
      const { results } = await request<{ results: SearchResult[] }>(
        `/api/search/messages?q=${encodeURIComponent(searchQuery.trim())}`,
        {},
        token,
      )
      setSearchResults(results)
      setError('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '搜索失败')
    } finally {
      setSearchLoading(false)
    }
  }

  async function handleOpenSearchResult(result: SearchResult) {
    setHighlightedMessageId(result.messageId)
    setActiveThread({ type: result.conversationType, id: result.threadId })
  }

  async function handleRecallMessage(message: Message) {
    if (!token) {
      return
    }

    const path =
      message.conversationType === 'channel'
        ? `/api/channels/messages/${message.id}`
        : `/api/chat/direct/messages/${message.id}`

    try {
      setSubmitting(true)
      await request<{ message: Message }>(
        path,
        {
          method: 'DELETE',
        },
        token,
      )
      await refreshLists(token)
      setSearchResults((prev) => prev.filter((result) => result.messageId !== message.id))
      setError('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '撤回失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleAddChannelMember(memberId: number) {
    if (!token || !activeChannel) {
      return
    }

    try {
      setSubmitting(true)
      const { channel } = await request<{ channel: Channel }>(
        `/api/channels/${activeChannel.id}/members`,
        {
          method: 'POST',
          body: JSON.stringify({ memberId }),
        },
        token,
      )
      setChannels((prev) => upsertChannel(prev, { ...channel, unreadCount: channel.unreadCount ?? 0 }))
      setError('')
      await refreshLists(token)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '添加成员失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRemoveChannelMember(memberId: number) {
    if (!token || !activeChannel) {
      return
    }

    try {
      setSubmitting(true)
      const { channel } = await request<{ channel: Channel }>(
        `/api/channels/${activeChannel.id}/members/${memberId}`,
        {
          method: 'DELETE',
        },
        token,
      )
      setChannels((prev) => upsertChannel(prev, { ...channel, unreadCount: channel.unreadCount ?? 0 }))
      setError('')
      await refreshLists(token)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '移除成员失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleUpdateUserRole(userId: number, role: 'admin' | 'member') {
    if (!token) {
      return
    }

    try {
      setSubmitting(true)
      await request<{ user: AuthUser }>(
        `/api/admin/users/${userId}/role`,
        {
          method: 'PATCH',
          body: JSON.stringify({ role }),
        },
        token,
      )
      await refreshAdminData(token)
      setError('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '更新角色失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDeleteAdminChannel(channelId: number) {
    if (!token) {
      return
    }

    try {
      setSubmitting(true)
      await request<{ ok: boolean }>(
        `/api/admin/channels/${channelId}`,
        {
          method: 'DELETE',
        },
        token,
      )
      await refreshAdminData(token)
      await refreshLists(token)
      setError('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '删除频道失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function submitTextMessage() {
    if (!token || !activeThread || !messageBody.trim()) {
      return
    }

    const path =
      activeThread.type === 'channel'
        ? `/api/channels/${activeThread.id}/messages`
        : `/api/chat/direct/${activeThread.id}/messages`

    try {
      setSubmitting(true)
      await request<{ message: Message }>(
        path,
        {
          method: 'POST',
          body: JSON.stringify({ body: messageBody }),
        },
        token,
      )
      setMessageBody('')
      await refreshLists(token)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '发送失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await submitTextMessage()
  }

  async function handleUploadFile(event: ChangeEvent<HTMLInputElement>) {
    if (!token || !activeThread) {
      return
    }

    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    const path =
      activeThread.type === 'channel'
        ? `/api/channels/${activeThread.id}/attachments`
        : `/api/chat/direct/${activeThread.id}/attachments`

    try {
      setSubmitting(true)
      const formData = new FormData()
      formData.append('file', file)

      if (messageBody.trim()) {
        formData.append('body', messageBody.trim())
      }

      await request<{ message: Message }>(
        path,
        {
          method: 'POST',
          body: formData,
        },
        token,
      )
      setMessageBody('')
      event.target.value = ''
      await refreshLists(token)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '上传失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCreateChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!token || !newChannelName.trim() || selectedChannelMembers.length === 0) {
      return
    }

    try {
      setSubmitting(true)
      const { channel } = await request<{ channel: Channel }>(
        '/api/channels',
        {
          method: 'POST',
          body: JSON.stringify({
            name: newChannelName,
            memberIds: selectedChannelMembers,
          }),
        },
        token,
      )

      setChannels((prev) => upsertChannel(prev, { ...channel, unreadCount: channel.unreadCount ?? 0 }))
      setActiveThread({ type: 'channel', id: channel.id })
      setShowCreateChannel(false)
      setNewChannelName('')
      setSelectedChannelMembers([])
      setError('')
      await refreshLists(token)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '创建群聊失败')
    } finally {
      setSubmitting(false)
    }
  }

  function toggleMemberSelection(memberId: number) {
    setSelectedChannelMembers((prev) =>
      prev.includes(memberId)
        ? prev.filter((item) => item !== memberId)
        : [...prev, memberId],
    )
  }

  if (loadingApp) {
    return (
      <main className="app-shell centered">
        <section className="status-card">
          <h1>团队聊天系统</h1>
          <p>正在初始化应用...</p>
        </section>
      </main>
    )
  }

  const channelSubtitle = activeChannel
    ? `${activeChannel.memberCount} 人群聊 · ${activeChannel.members
        .map((member) => member.displayName)
        .join('、')}`
    : ''
  const threadTitle = activeChannel?.name || activeContact?.displayName || ''
  const threadSubtitle = activeChannel
    ? channelSubtitle
    : activeContact
      ? '一对一私聊 · 支持文件发送与历史消息'
      : ''

  return (
    <main className="app-shell">
      {!currentUser ? (
        <section className="login-layout">
          <div className="login-hero">
            <div className="hero-badge">
              <Sparkles size={16} />
              <span>Inspired by Slack + Linear</span>
            </div>
            <p className="eyebrow">内部协作 IM MVP</p>
            <h1>团队聊天系统</h1>
            <p className="hero-copy">
              现在支持账号密码登录、一对一私聊、群聊频道、历史消息和文件上传。当前内置了 3 个演示账号，方便你直接验证完整流程。
            </p>
            <div className="hero-metrics">
              <div className="hero-metric">
                <MessageSquareText size={16} />
                <span>实时沟通</span>
              </div>
              <div className="hero-metric">
                <Bell size={16} />
                <span>未读通知</span>
              </div>
              <div className="hero-metric">
                <ShieldCheck size={16} />
                <span>后台管理</span>
              </div>
            </div>
            <div className="demo-grid">
              {demoAccounts.map((account) => (
                <button
                  key={account.username}
                  className="demo-card"
                  onClick={() =>
                    setLoginForm({
                      username: account.username,
                      password: account.password,
                    })
                  }
                >
                  <div className="demo-card-top">
                    <div className="contact-avatar">{account.displayName.slice(0, 1)}</div>
                    <div className="demo-card-copy">
                      <strong>{account.displayName}</strong>
                      <span>{account.username}</span>
                    </div>
                  </div>
                  <span className="demo-card-tip">点击自动填充</span>
                </button>
              ))}
            </div>
          </div>

          <form className="login-card" onSubmit={handleLogin}>
            <div className="panel-title-row">
              <ShieldCheck size={18} />
              <h2>账号登录</h2>
            </div>
            <label>
              账号
              <input
                value={loginForm.username}
                placeholder="例如 li.lei"
                autoComplete="username"
                onChange={(event) =>
                  setLoginForm((prev) => ({ ...prev, username: event.target.value }))
                }
              />
            </label>
            <label>
              密码
              <input
                type="password"
                value={loginForm.password}
                placeholder="password123"
                autoComplete="current-password"
                onChange={(event) =>
                  setLoginForm((prev) => ({ ...prev, password: event.target.value }))
                }
              />
            </label>
            {error ? <p className="error-text">{error}</p> : null}
            <button type="submit" className="primary-button" disabled={submitting}>
              {submitting ? '登录中...' : '进入聊天'}
            </button>
          </form>
        </section>
      ) : (
        <section className="chat-layout">
          <aside className="sidebar">
            <div className="sidebar-fixed">
              <div className="sidebar-header">
                <div>
                  <h2>{currentUser.displayName}</h2>
                  <p className="muted">
                    {currentUser.username}
                    {currentUser.role === 'admin' ? ' · 管理员' : ''}
                  </p>
                </div>
                <div className="header-actions">
                  {currentUser.role === 'admin' ? (
                    <button
                      className="ghost-button ghost-button-sm"
                      onClick={async () => {
                        setShowAdminConsole((prev) => !prev)
                        if (!showAdminConsole && token) {
                          await refreshAdminData(token)
                        }
                      }}
                    >
                      <LayoutDashboard size={14} />
                    </button>
                  ) : null}
                  <button className="ghost-button ghost-button-sm" onClick={logout}>
                    <Crown size={14} />
                  </button>
                </div>
              </div>

              <div className="sidebar-toolbar">
                <form className="toolbar-search" onSubmit={handleSearch}>
                  <Search size={14} className="toolbar-search-icon" />
                  <input
                    value={searchQuery}
                    placeholder="搜索消息"
                    onChange={(event) => setSearchQuery(event.target.value)}
                  />
                </form>
                <button
                  className="ghost-button ghost-button-sm"
                  onClick={() => setShowCreateChannel((prev) => !prev)}
                  title="新建群聊"
                >
                  <UserRoundPlus size={14} />
                </button>
                {totalUnread > 0 ? (
                  <span className="unread-badge toolbar-badge">{totalUnread}</span>
                ) : null}
              </div>

              <div className="sidebar-status">
                <Sparkles size={12} />
                <span>{connectionText}</span>
                <span>{channels.length} 群 · {contacts.length} 人</span>
              </div>
            </div>

            {searchQuery.trim().length >= 2 ? (
              <div className="sidebar-overlay-panel">
                <p className="section-label">搜索结果</p>
                {searchLoading ? (
                  <div className="search-empty">正在搜索...</div>
                ) : searchResults.length === 0 ? (
                  <div className="search-empty">没有找到相关消息。</div>
                ) : (
                  searchResults.map((result) => (
                    <button
                      key={result.id}
                      className="search-result-item"
                      onClick={() => void handleOpenSearchResult(result)}
                    >
                      <div className="contact-row">
                        <strong>{result.threadName}</strong>
                        <span>{formatTime(result.createdAt)}</span>
                      </div>
                      <div className="search-result-meta">
                        {result.conversationType === 'channel' ? '群聊' : '私聊'} · {result.senderName}
                      </div>
                      <div className="search-result-body">
                        {result.attachmentName
                          ? `[文件] ${result.attachmentName}${result.body ? ` · ${result.body}` : ''}`
                          : result.body || '匹配到消息'}
                      </div>
                    </button>
                  ))
                )}
                <button
                  className="ghost-button"
                  onClick={() => {
                    setSearchQuery('')
                    setSearchResults([])
                    setHighlightedMessageId(null)
                  }}
                >
                  关闭搜索
                </button>
              </div>
            ) : showCreateChannel ? (
              <div className="sidebar-overlay-panel">
                <form className="create-channel-form" onSubmit={handleCreateChannel}>
                  <label>
                    群聊名称
                    <input
                      value={newChannelName}
                      placeholder="例如 产品项目组"
                      onChange={(event) => setNewChannelName(event.target.value)}
                    />
                  </label>
                  <div className="member-picker">
                    <p className="section-label">选择成员</p>
                    {contacts.map((contact) => (
                      <label key={contact.id} className="member-option">
                        <input
                          type="checkbox"
                          checked={selectedChannelMembers.includes(contact.id)}
                          onChange={() => toggleMemberSelection(contact.id)}
                        />
                        <span>{contact.displayName}</span>
                      </label>
                    ))}
                  </div>
                  <div className="header-actions">
                    <button
                      type="submit"
                      className="primary-button"
                      disabled={submitting || !newChannelName.trim() || selectedChannelMembers.length === 0}
                    >
                      创建群聊
                    </button>
                    <button type="button" className="ghost-button" onClick={() => setShowCreateChannel(false)}>
                      取消
                    </button>
                  </div>
                </form>
              </div>
            ) : (
              <div className="contact-list">
              <p className="section-label section-label-with-icon">
                <Hash size={14} />
                群聊频道
              </p>
              {channels.map((channel) => (
                <button
                  key={channel.id}
                  className={`contact-item ${activeThread?.type === 'channel' && activeThread.id === channel.id ? 'active' : ''}`}
                  onClick={() => setActiveThread({ type: 'channel', id: channel.id })}
                >
                  <div className="contact-avatar channel-avatar">群</div>
                  <div className="contact-copy">
                    <div className="contact-row">
                      <strong>{channel.name}</strong>
                      {channel.lastMessage?.createdAt ? (
                        <span>{formatTime(channel.lastMessage.createdAt)}</span>
                      ) : null}
                    </div>
                    <div className="contact-row">
                      <span className="muted">{buildPreview(channel.lastMessage)}</span>
                      {channel.unreadCount > 0 ? (
                        <span className="unread-badge">{channel.unreadCount}</span>
                      ) : null}
                    </div>
                  </div>
                </button>
              ))}

              <p className="section-label section-label-with-icon">
                <MessageCircle size={14} />
                私聊
              </p>
              {contacts.map((contact) => (
                <button
                  key={contact.id}
                  className={`contact-item ${activeThread?.type === 'direct' && activeThread.id === contact.id ? 'active' : ''}`}
                  onClick={() => setActiveThread({ type: 'direct', id: contact.id })}
                >
                  <div className="contact-avatar">{contact.displayName.slice(0, 1)}</div>
                  <div className="contact-copy">
                    <div className="contact-row">
                      <strong>{contact.displayName}</strong>
                      {contact.lastMessage?.createdAt ? (
                        <span>{formatTime(contact.lastMessage.createdAt)}</span>
                      ) : null}
                    </div>
                    <div className="contact-row">
                      <span className="muted">{buildPreview(contact.lastMessage)}</span>
                      {contact.unreadCount > 0 ? (
                        <span className="unread-badge">{contact.unreadCount}</span>
                      ) : null}
                    </div>
                  </div>
                </button>
              ))}
            </div>
            )}
          </aside>

          <section className="chat-panel">
            {showAdminConsole && currentUser.role === 'admin' ? (
              <section className="admin-console">
                <header className="chat-header">
                  <div>
                    <div className="panel-title-row">
                      <LayoutDashboard size={18} />
                      <h2>管理员后台</h2>
                    </div>
                    <p className="muted">查看系统概览，管理用户角色和频道。</p>
                  </div>
                </header>

                <div className="admin-section">
                  <div className="admin-stats-grid">
                    <div className="admin-stat-card">
                      <Users size={16} />
                      <strong>{adminOverview?.userCount ?? 0}</strong>
                      <span>用户总数</span>
                    </div>
                    <div className="admin-stat-card">
                      <Crown size={16} />
                      <strong>{adminOverview?.adminCount ?? 0}</strong>
                      <span>管理员数</span>
                    </div>
                    <div className="admin-stat-card">
                      <Hash size={16} />
                      <strong>{adminOverview?.channelCount ?? 0}</strong>
                      <span>频道数</span>
                    </div>
                    <div className="admin-stat-card">
                      <MessageSquareText size={16} />
                      <strong>{adminOverview?.messageCount ?? 0}</strong>
                      <span>消息总数</span>
                    </div>
                    <div className="admin-stat-card">
                      <Bell size={16} />
                      <strong>{adminOverview?.todayMessageCount ?? 0}</strong>
                      <span>今日消息</span>
                    </div>
                  </div>
                </div>

                <div className="admin-section">
                  <div className="member-manager-summary">
                    <strong>用户管理</strong>
                    <span className="muted">{adminUsers.length} 位用户</span>
                  </div>
                  <div className="admin-list">
                    {adminUsers.map((user) => (
                      <div key={user.id} className="admin-list-item">
                        <div>
                          <strong>{user.displayName}</strong>
                          <div className="muted">
                            {user.username} · {user.role === 'admin' ? '管理员' : '普通成员'}
                          </div>
                        </div>
                        {user.id !== currentUser.id ? (
                          <button
                            className="ghost-button"
                            onClick={() =>
                              void handleUpdateUserRole(
                                user.id,
                                user.role === 'admin' ? 'member' : 'admin',
                              )
                            }
                            disabled={submitting}
                          >
                            <ShieldCheck size={16} />
                            {user.role === 'admin' ? '取消管理员' : '设为管理员'}
                          </button>
                        ) : (
                          <span className="muted">当前账号</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="admin-section">
                  <div className="member-manager-summary">
                    <strong>频道管理</strong>
                    <span className="muted">{adminChannels.length} 个频道</span>
                  </div>
                  <div className="admin-list">
                    {adminChannels.map((channel) => (
                      <div key={channel.id} className="admin-list-item">
                        <div>
                          <strong>{channel.name}</strong>
                          <div className="muted">{channel.memberCount} 人 · 创建者 ID {channel.createdBy}</div>
                        </div>
                        <button
                          className="ghost-button danger-button"
                          onClick={() => void handleDeleteAdminChannel(channel.id)}
                          disabled={submitting}
                        >
                          <ShieldCheck size={16} />
                          删除频道
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            ) : activeThread ? (
              <>
                <header className="chat-header">
                  <div>
                    <h2>{threadTitle}</h2>
                    <p className="muted">{threadSubtitle}</p>
                  </div>
                  <div className="header-actions">
                    {canManageActiveChannel ? (
                      <button
                        className="ghost-button"
                        onClick={() => setShowMemberManager((prev) => !prev)}
                        disabled={submitting}
                      >
                        <Users size={16} />
                        {showMemberManager ? '收起成员管理' : '管理成员'}
                      </button>
                    ) : null}
                    <button
                      className="ghost-button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={submitting}
                    >
                      <Upload size={16} />
                      上传文件
                    </button>
                  </div>
                </header>

                {activeChannel ? (
                  <section className="member-manager-card">
                    <div className="member-manager-summary">
                      <strong className="section-label-with-icon">
                        <Users size={14} />
                        群成员
                      </strong>
                      <span className="muted">{activeChannel.memberCount} 人</span>
                    </div>
                    <div className="member-chip-list">
                      {activeChannel.members.map((member) => (
                        <div key={member.id} className="member-chip">
                          <span>{member.displayName}</span>
                          {canManageActiveChannel && member.id !== activeChannel.createdBy ? (
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => void handleRemoveChannelMember(member.id)}
                            >
                              移除
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>

                    {canManageActiveChannel && showMemberManager ? (
                      <div className="member-manager-panel">
                        <p className="section-label">可添加成员</p>
                        {availableMembersForActiveChannel.length === 0 ? (
                          <div className="notification-empty">当前没有可添加的联系人。</div>
                        ) : (
                          <div className="member-chip-list">
                            {availableMembersForActiveChannel.map((contact) => (
                              <button
                                key={contact.id}
                                type="button"
                                className="member-chip member-chip-action"
                                onClick={() => void handleAddChannelMember(contact.id)}
                              >
                                <span>{contact.displayName}</span>
                                <span className="muted">添加</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </section>
                ) : null}

                <div className="message-list">
                  {loadingMessages ? (
                    <div className="empty-state">正在加载消息...</div>
                  ) : messages.length === 0 ? (
                    <div className="empty-state">
                      还没有聊天记录，先发送第一条消息吧。
                    </div>
                  ) : (
                    messages.map((message) => {
                      const isMine = message.senderId === currentUser.id

                      return (
                        <article
                          key={message.id}
                          data-message-id={message.id}
                          className={`message-bubble ${isMine ? 'mine' : 'theirs'} ${highlightedMessageId === message.id ? 'highlighted' : ''}`}
                        >
                          <div className="message-meta">
                            <strong>{isMine ? '我' : message.senderName}</strong>
                            <div className="message-meta-actions">
                              <span>{formatTime(message.createdAt)}</span>
                              {isMine && !message.deletedAt ? (
                                <button
                                  type="button"
                                  className="link-button"
                                  onClick={() => void handleRecallMessage(message)}
                                >
                                  撤回
                                </button>
                              ) : null}
                            </div>
                          </div>
                          {message.deletedAt ? (
                            <p className="deleted-text">该消息已撤回</p>
                          ) : null}
                          {!message.deletedAt && message.body ? <p>{message.body}</p> : null}
                          {!message.deletedAt && message.attachmentUrl && message.attachmentName ? (
                            <a
                              className="file-card"
                              href={message.attachmentUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <Upload size={16} />
                              <span>{message.attachmentName}</span>
                              <span>{formatSize(message.attachmentSize)}</span>
                            </a>
                          ) : null}
                        </article>
                      )
                    })
                  )}
                  <div ref={messageEndRef} />
                </div>

                <form className="composer" onSubmit={handleSendMessage}>
                  <input
                    type="file"
                    ref={fileInputRef}
                    className="hidden-file-input"
                    onChange={handleUploadFile}
                  />
                  <textarea
                    rows={3}
                    value={messageBody}
                    placeholder={
                      activeThread.type === 'channel'
                        ? '向群聊发送消息，Enter 发送，Shift + Enter 换行'
                        : '输入消息，Enter 发送，Shift + Enter 换行'
                    }
                    onChange={(event) => setMessageBody(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        void submitTextMessage()
                      }
                    }}
                  />
                  <div className="composer-actions">
                    {error ? (
                      <p className="error-text">{error}</p>
                    ) : (
                      <span className="muted">支持单文件上传，大小上限 10MB。</span>
                    )}
                    <button type="submit" className="primary-button" disabled={sendDisabled}>
                      <Send size={16} />
                      {submitting ? '发送中...' : '发送消息'}
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <div className="empty-state full-height">请选择一个群聊或联系人开始聊天。</div>
            )}
          </section>
        </section>
      )}
    </main>
  )
}

export default App
