import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model, QueryFilter } from 'mongoose';
import { assertAccountActive } from '../auth/account-access.js';
import { AccessDeniedException } from '../common/exceptions/access-denied.exception.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import {
  CursorPaginationQueryDto,
  createCursorPaginatedResponse,
  afterCursor,
} from '../common/pagination/index.js';
import {
  AccountStatus,
  Conversation,
  DirectMessage,
  Follow,
  MessagingEventType,
  User,
} from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { withUserLocks } from '../mongo/with-user-locks.js';
import {
  ConversationDto,
  ConversationPageDto,
  ConversationReadDto,
  ConversationsQueryDto,
  MessageDto,
  MessagePageDto,
  MessagingInbox,
  MessagingContactDto,
  SendMessageDto,
  SendMessageResponseDto,
} from './dto/messaging.dto.js';
import { MessagingEventsService } from './messaging-events.service.js';

type Relationships = { following: Set<string>; followers: Set<string> };
const members = (userId: string): QueryFilter<Conversation> => ({
  $or: [{ lowId: userId }, { highId: userId }],
});
const peerIdOf = (conversation: Conversation, userId: string) =>
  conversation.lowId === userId ? conversation.highId : conversation.lowId;
const myReadSequence = (conversation: Conversation, userId: string) =>
  conversation.lowId === userId
    ? conversation.lowReadSequence
    : conversation.highReadSequence;

function messageDto(message: DirectMessage): MessageDto {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    recipientId: message.recipientId,
    clientMessageId: message.clientMessageId,
    sequence: message.sequence,
    body: message.body,
    createdAt: message.createdAt,
  };
}

@Injectable()
export class MessagingService {
  constructor(
    private readonly mongo: MongoService,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Follow.name) private readonly follows: Model<Follow>,
    @InjectModel(Conversation.name)
    private readonly conversations: Model<Conversation>,
    @InjectModel(DirectMessage.name)
    private readonly messages: Model<DirectMessage>,
    private readonly events: MessagingEventsService,
  ) {}

  async contact(userId: string, peerId: string): Promise<MessagingContactDto> {
    if (userId === peerId)
      throw new InvalidInputException(
        'SELF_MESSAGE_NOT_ALLOWED',
        'You cannot message yourself',
      );
    return this.mongo.withTransaction(async (session) => {
      const peer = await this.users
        .findById(peerId)
        .select('username fullName avatarUrl isProfessional status')
        .session(session)
        .exec();
      if (!peer || peer.status !== AccountStatus.ACTIVE)
        throw new ResourceNotFoundException(
          'NOT_FOUND',
          'Recipient is unavailable',
        );
      const relationships = await this.relationships(userId, session);
      const [lowId, highId] = [userId, peerId].sort();
      const conversation = await this.conversations
        .findOne({ lowId, highId })
        .select('_id')
        .session(session)
        .exec();
      const followsPeer = relationships.following.has(peerId);
      return {
        peer: {
          id: peer.id,
          username: peer.username,
          fullName: peer.fullName,
          avatarUrl: peer.avatarUrl,
          isProfessional: peer.isProfessional,
        },
        conversationId: conversation?.id ?? null,
        box: this.box(peerId, relationships),
        followsPeer,
        peerFollowsYou: relationships.followers.has(peerId),
        canSend: followsPeer,
      };
    });
  }

  async sendToUser(
    senderId: string,
    recipientId: string,
    dto: SendMessageDto,
    expectedConversationId?: string,
  ): Promise<SendMessageResponseDto> {
    if (senderId === recipientId) {
      throw new InvalidInputException(
        'SELF_MESSAGE_NOT_ALLOWED',
        'You cannot message yourself',
      );
    }
    return withUserLocks(
      this.mongo,
      [senderId, recipientId],
      async (session) => {
        await this.requireSender(senderId, session);
        const recipient = await this.users
          .findById(recipientId)
          .session(session)
          .exec();
        if (!recipient || recipient.status !== AccountStatus.ACTIVE) {
          throw new ResourceNotFoundException(
            'NOT_FOUND',
            'Recipient is unavailable',
          );
        }
        const follows = await this.follows
          .exists({ followerId: senderId, followingId: recipientId })
          .session(session);
        if (!follows) {
          throw new AccessDeniedException(
            'MESSAGE_FOLLOW_REQUIRED',
            'Follow the recipient before sending messages',
          );
        }
        const [lowId, highId] = [senderId, recipientId].sort();
        let conversation = await this.conversations
          .findOne({ lowId, highId })
          .session(session)
          .exec();
        if (
          expectedConversationId &&
          conversation?.id !== expectedConversationId
        ) {
          throw new ResourceNotFoundException(
            'NOT_FOUND',
            'Conversation not found',
          );
        }
        if (!conversation) {
          [conversation] = await this.conversations.create(
            [{ lowId, highId }],
            { session },
          );
        }
        const previous = await this.messages
          .findOne({
            conversationId: conversation.id,
            senderId,
            clientMessageId: dto.clientMessageId,
          })
          .session(session)
          .exec();
        if (previous) {
          if (previous.body !== dto.body) {
            throw new StateConflictException(
              'MESSAGE_ID_CONFLICT',
              'This clientMessageId was already used for different text',
            );
          }
          return {
            conversationId: conversation.id,
            message: messageDto(previous),
          };
        }
        const sequence = conversation.sequence + 1;
        const [message] = await this.messages.create(
          [
            {
              conversationId: conversation.id,
              senderId,
              recipientId,
              sequence,
              clientMessageId: dto.clientMessageId,
              body: dto.body,
            },
          ],
          { session },
        );
        // Sequence orders messages even when they share a millisecond timestamp.
        // Keep the inbox order monotonic if the host clock moves backwards.
        const lastMessageAt = new Date(
          Math.max(
            message.createdAt.getTime(),
            conversation.lastMessageAt?.getTime() ?? 0,
          ),
        );
        await this.conversations.updateOne(
          { _id: conversation.id },
          {
            $set: {
              sequence,
              lastMessageAt,
              lastMessageId: message.id,
              lastSenderId: senderId,
              lastMessageBody: message.body,
            },
          },
          { session },
        );
        await this.events.record(
          [senderId, recipientId],
          {
            type: MessagingEventType.MESSAGE_CREATED,
            conversationId: conversation.id,
            messageId: message.id,
          },
          session,
        );
        return {
          conversationId: conversation.id,
          message: messageDto(message),
        };
      },
    );
  }

  async sendToConversation(
    userId: string,
    id: string,
    dto: SendMessageDto,
  ): Promise<SendMessageResponseDto> {
    const conversation = await this.requireConversation(userId, id);
    // Rechecks membership/account/follow state in the transaction, not from a client-supplied peer.
    return this.sendToUser(userId, peerIdOf(conversation, userId), dto, id);
  }

  async listConversations(
    userId: string,
    query: ConversationsQueryDto,
  ): Promise<ConversationPageDto> {
    return this.mongo.withTransaction(async (session) => {
      const relationships = await this.relationships(userId, session);
      const friends = [...relationships.following].filter((id) =>
        relationships.followers.has(id),
      );
      const peerFilter =
        query.box === MessagingInbox.FRIENDS
          ? { $in: friends }
          : { $nin: friends };
      // Filter the selected inbox BEFORE limiting, so other categories cannot consume the page.
      const filter: QueryFilter<Conversation> = {
        $or: [
          { lowId: userId, highId: peerFilter },
          { highId: userId, lowId: peerFilter },
        ],
        lastMessageAt: { $ne: null },
      };
      if (query.cursor) {
        const cursor = await this.requireConversation(
          userId,
          query.cursor,
          session,
        );
        const peer = peerIdOf(cursor, userId);
        if (
          !cursor.lastMessageAt ||
          this.box(peer, relationships) !== query.box
        )
          this.invalidCursor();
        filter.$and = [
          afterCursor<Conversation>('lastMessageAt', {
            value: cursor.lastMessageAt,
            id: cursor.id,
          }),
        ];
      }
      const rows = await this.conversations
        .find(filter)
        .sort({ lastMessageAt: -1, _id: -1 })
        .limit(query.limit + 1)
        .session(session)
        .exec();
      const page = createCursorPaginatedResponse(rows, query.limit);
      return {
        items: await this.hydrate(userId, page.items, relationships, session),
        nextCursor: page.nextCursor,
      };
    });
  }

  async getConversation(userId: string, id: string): Promise<ConversationDto> {
    return this.mongo.withTransaction(async (session) => {
      const conversation = await this.requireConversation(userId, id, session);
      const relationships = await this.relationships(userId, session);
      const [result] = await this.hydrate(
        userId,
        [conversation],
        relationships,
        session,
      );
      if (!result)
        throw new ResourceNotFoundException(
          'NOT_FOUND',
          'Conversation not found',
        );
      return result;
    });
  }

  async listMessages(
    userId: string,
    id: string,
    query: CursorPaginationQueryDto,
  ): Promise<MessagePageDto> {
    return this.mongo.withTransaction(async (session) => {
      await this.requireConversation(userId, id, session);
      const filter: QueryFilter<DirectMessage> = { conversationId: id };
      if (query.cursor) {
        const cursor = await this.messages
          .findOne({ _id: query.cursor, conversationId: id })
          .select('sequence')
          .session(session)
          .exec();
        if (!cursor) this.invalidCursor();
        filter.sequence = { $lt: cursor.sequence };
      }
      const rows = await this.messages
        .find(filter)
        .sort({ sequence: -1 })
        .limit(query.limit + 1)
        .session(session)
        .exec();
      const page = createCursorPaginatedResponse(rows, query.limit);
      return { ...page, items: page.items.map(messageDto) };
    });
  }

  async markRead(
    userId: string,
    id: string,
    messageId: string,
  ): Promise<ConversationReadDto> {
    const initial = await this.requireConversation(userId, id);
    return withUserLocks(
      this.mongo,
      [initial.lowId, initial.highId],
      async (session) => {
        await this.requireSender(userId, session);
        const conversation = await this.requireConversation(
          userId,
          id,
          session,
        );
        const message = await this.messages
          .findOne({ _id: messageId, conversationId: id })
          .session(session)
          .exec();
        if (!message)
          throw new ResourceNotFoundException('NOT_FOUND', 'Message not found');
        const previous = myReadSequence(conversation, userId);
        const readSequence = Math.max(previous, message.sequence);
        if (readSequence > previous) {
          const field =
            conversation.lowId === userId
              ? 'lowReadSequence'
              : 'highReadSequence';
          await this.conversations.updateOne(
            { _id: id },
            { $set: { [field]: readSequence } },
            { session },
          );
          await this.events.record(
            [conversation.lowId, conversation.highId],
            {
              type: MessagingEventType.CONVERSATION_READ,
              conversationId: id,
              readerId: userId,
              readSequence,
            },
            session,
          );
        }
        const unreadCount = await this.messages
          .countDocuments({
            conversationId: id,
            recipientId: userId,
            sequence: { $gt: readSequence },
          })
          .session(session)
          .exec();
        return { conversationId: id, readSequence, unreadCount };
      },
    );
  }

  private async requireSender(
    id: string,
    session: ClientSession,
  ): Promise<void> {
    const user = await this.users.findById(id).session(session).exec();
    if (!user)
      throw new ResourceNotFoundException(
        'NOT_FOUND',
        'Account no longer exists',
      );
    assertAccountActive(user.status);
  }

  private async requireConversation(
    userId: string,
    id: string,
    session?: ClientSession,
  ): Promise<Conversation> {
    const conversation = await this.conversations
      .findOne({ _id: id, ...members(userId) })
      .session(session ?? null)
      .exec();
    // Membership is enforced on every path, including for administrators.
    if (!conversation)
      throw new ResourceNotFoundException(
        'NOT_FOUND',
        'Conversation not found',
      );
    return conversation;
  }

  private async relationships(
    userId: string,
    session: ClientSession,
  ): Promise<Relationships> {
    const rows = await this.follows
      .find({ $or: [{ followerId: userId }, { followingId: userId }] })
      .select('followerId followingId')
      .session(session)
      .exec();
    return {
      following: new Set(
        rows
          .filter((row) => row.followerId === userId)
          .map((row) => row.followingId),
      ),
      followers: new Set(
        rows
          .filter((row) => row.followingId === userId)
          .map((row) => row.followerId),
      ),
    };
  }

  private box(peerId: string, relationships: Relationships): MessagingInbox {
    return relationships.following.has(peerId) &&
      relationships.followers.has(peerId)
      ? MessagingInbox.FRIENDS
      : MessagingInbox.REQUESTS;
  }

  private async hydrate(
    userId: string,
    rows: Conversation[],
    relationships: Relationships,
    session: ClientSession,
  ): Promise<ConversationDto[]> {
    if (!rows.length) return [];
    const peers = await this.users
      .find({ _id: { $in: rows.map((row) => peerIdOf(row, userId)) } })
      .select('username fullName avatarUrl isProfessional status')
      .session(session)
      .exec();
    const byId = new Map(peers.map((peer) => [peer.id, peer]));
    const counts = await this.messages
      .aggregate<{ _id: string; count: number }>([
        {
          $match: {
            recipientId: userId,
            $or: rows.map((row) => ({
              conversationId: row.id,
              sequence: { $gt: myReadSequence(row, userId) },
            })),
          },
        },
        { $group: { _id: '$conversationId', count: { $sum: 1 } } },
      ])
      .session(session)
      .exec();
    const unread = new Map(counts.map((row) => [row._id, row.count]));
    return rows.flatMap((row) => {
      const peer = byId.get(peerIdOf(row, userId));
      if (!peer) return [];
      const followsPeer = relationships.following.has(peer.id);
      const peerFollowsYou = relationships.followers.has(peer.id);
      const box = this.box(peer.id, relationships);
      return [
        {
          id: row.id,
          peer: {
            id: peer.id,
            username: peer.username,
            fullName: peer.fullName,
            avatarUrl: peer.avatarUrl,
            isProfessional: peer.isProfessional,
          },
          box,
          followsPeer,
          peerFollowsYou,
          canSend: followsPeer && peer.status === AccountStatus.ACTIVE,
          requestDirection:
            box === MessagingInbox.FRIENDS
              ? null
              : followsPeer
                ? ('outgoing' as const)
                : peerFollowsYou
                  ? ('incoming' as const)
                  : null,
          lastMessage:
            row.lastMessageId && row.lastSenderId && row.lastMessageAt
              ? {
                  id: row.lastMessageId,
                  senderId: row.lastSenderId,
                  body: row.lastMessageBody ?? '',
                  createdAt: row.lastMessageAt,
                }
              : null,
          unreadCount: unread.get(row.id) ?? 0,
          myReadSequence: myReadSequence(row, userId),
          peerReadSequence:
            row.lowId === userId ? row.highReadSequence : row.lowReadSequence,
        },
      ];
    });
  }

  private invalidCursor(): never {
    throw new InvalidInputException(
      'MESSAGE_CURSOR_INVALID',
      'Cursor is missing, belongs to another conversation, or its inbox changed',
    );
  }
}
