import { runtimeConfig } from '../config/runtime-config.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Model } from 'mongoose';
import {
  exhaustMap,
  interval,
  merge,
  Observable,
  takeUntil,
  takeWhile,
} from 'rxjs';
import type { AuthenticatedRequest } from '../auth-core/auth.types.js';
import { JwtAuthGuard } from '../auth-core/jwt-auth.guard.js';
import { extractBearerToken } from '../auth-core/bearer-token.js';
import { CursorPaginationQueryDto } from '../common/pagination/index.js';
import { UnauthenticatedException } from '../common/exceptions/unauthenticated.exception.js';
import { AccountStatus, User } from '../mongo/models.js';
import {
  ConversationDto,
  ConversationPageDto,
  ConversationReadDto,
  ConversationsQueryDto,
  DeleteMessageRequestDto,
  DeletedMessageRequestDto,
  MessagePageDto,
  MessagingContactDto,
  ReadConversationDto,
  SendMessageDto,
  SendMessageResponseDto,
  SharePostDto,
} from './dto/messaging.dto.js';
import {
  MessagingEventsService,
  type MessagingSignal,
} from './messaging-events.service.js';
import { MessagingService } from './messaging.service.js';

@ApiTags('messaging')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('messaging')
export class MessagingController {
  constructor(
    private readonly messaging: MessagingService,
    private readonly events: MessagingEventsService,
    private readonly jwt: JwtService,
    @InjectModel(User.name) private readonly users: Model<User>,
  ) {}

  @Sse('events')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Header('X-Accel-Buffering', 'no')
  @ApiOperation({
    summary: 'Private messaging events over SSE',
    description:
      'Use fetch with Authorization, never a JWT in the URL. Events only invalidate GET caches. Reload inbox/history on stream.ready and after reconnect; fall back to periodic GET while unavailable.',
  })
  stream(@Req() request: AuthenticatedRequest): Observable<MessageEvent> {
    const token = extractBearerToken(request.headers.authorization);
    if (!token)
      throw new UnauthenticatedException(
        'UNAUTHORIZED',
        'Authentication required',
      );
    const authenticate = async () => {
      try {
        await this.jwt.verifyAsync(token);
        const user = await this.users
          .findById(request.user.sub)
          .select('status')
          .exec();
        return user?.status === AccountStatus.ACTIVE;
      } catch {
        return false;
      }
    };
    const frame = (signal: MessagingSignal): MessageEvent => {
      if (!('id' in signal)) return { type: `stream.${signal.type}`, data: {} };
      // Do not serialize userIds or message text from the internal outbox.
      return {
        type: signal.type,
        id: signal.id,
        data: {
          conversationId: signal.conversationId,
          messageId: signal.messageId,
          readerId: signal.readerId,
          readSequence: signal.readSequence,
        },
      };
    };
    // Serialize async authorization checks so a burst cannot reorder messages or read receipts.
    const live = new Observable<MessageEvent>((observer) => {
      let closed = false;
      let pending = Promise.resolve();
      const subscription = this.events
        .stream(request.user.sub)
        .subscribe((signal) => {
          pending = pending
            .then(async () => {
              if (closed) return;
              if (!(await authenticate())) {
                observer.next({ type: 'session.expired', data: {} });
                observer.complete();
                return;
              }
              if (!closed) observer.next(frame(signal));
            })
            .catch(() => {
              if (!closed) observer.complete();
            });
        });
      return () => {
        closed = true;
        subscription.unsubscribe();
      };
    });
    const heartbeat = interval(runtimeConfig.MESSAGING_SSE_HEARTBEAT_MS).pipe(
      exhaustMap(async (): Promise<MessageEvent> =>
        (await authenticate())
          ? { type: 'ping', data: { connected: this.events.isConnected() } }
          : { type: 'session.expired', data: {} },
      ),
    );
    return merge(live, heartbeat).pipe(
      takeUntil(this.events.closed$),
      takeWhile((event) => event.type !== 'session.expired', true),
    );
  }

  @Get('conversations')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'List your friends or message requests, newest activity first',
  })
  @ApiOkResponse({ type: ConversationPageDto })
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ConversationsQueryDto,
  ): Promise<ConversationPageDto> {
    return this.messaging.listConversations(request.user.sub, query);
  }

  @Get('conversations/:id')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Get your conversation and current follow permissions',
  })
  @ApiOkResponse({ type: ConversationDto })
  get(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationDto> {
    return this.messaging.getConversation(request.user.sub, id);
  }

  @Get('conversations/:id/messages')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Read your messages, newest sequence first' })
  @ApiOkResponse({ type: MessagePageDto })
  messages(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CursorPaginationQueryDto,
  ): Promise<MessagePageDto> {
    return this.messaging.listMessages(request.user.sub, id, query);
  }

  @Get('users/:userId')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary:
      'Resolve an existing conversation and follow permissions without creating one',
  })
  @ApiOkResponse({ type: MessagingContactDto })
  contact(
    @Req() request: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe) id: string,
  ): Promise<MessagingContactDto> {
    return this.messaging.contact(request.user.sub, id);
  }

  @Post('conversations/:id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Accept an incoming request; both participants can message without following',
  })
  @ApiOkResponse({ type: ConversationDto })
  accept(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationDto> {
    return this.messaging.acceptRequest(request.user.sub, id);
  }

  @Delete('conversations/:id/request')
  @ApiOperation({
    summary:
      'Hide an incoming request and its old history for yourself; newer messages remain visible',
  })
  @ApiOkResponse({ type: DeletedMessageRequestDto })
  deleteRequest(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeleteMessageRequestDto,
  ): Promise<DeletedMessageRequestDto> {
    return this.messaging.deleteRequest(
      request.user.sub,
      id,
      dto.throughMessageId,
    );
  }

  @Post('users/:userId/messages')
  @ApiOperation({
    summary:
      'Send a message when following the recipient or after request acceptance',
  })
  @ApiCreatedResponse({ type: SendMessageResponseDto })
  sendToUser(
    @Req() request: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
  ): Promise<SendMessageResponseDto> {
    return this.messaging.sendToUser(request.user.sub, id, dto);
  }

  @Post('conversations/:id/messages')
  @ApiOperation({
    summary:
      'Send in your existing conversation; account and follow/acceptance permission are rechecked on every send',
  })
  @ApiCreatedResponse({ type: SendMessageResponseDto })
  send(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
  ): Promise<SendMessageResponseDto> {
    return this.messaging.sendToConversation(request.user.sub, id, dto);
  }

  @Put('conversations/:id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Advance your read position to a displayed message; never moves backwards',
  })
  @ApiOkResponse({ type: ConversationReadDto })
  read(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReadConversationDto,
  ): Promise<ConversationReadDto> {
    return this.messaging.markRead(request.user.sub, id, dto.messageId);
  }

  @Post('users/:userId/shared-posts')
  @ApiOperation({
    summary: 'Share a published post or blog with a permitted recipient',
  })
  @ApiCreatedResponse({ type: SendMessageResponseDto })
  shareToUser(
    @Req() request: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe) id: string,
    @Body() dto: SharePostDto,
  ): Promise<SendMessageResponseDto> {
    return this.messaging.sharePostToUser(request.user.sub, id, dto);
  }

  @Post('conversations/:id/shared-posts')
  @ApiOperation({
    summary: 'Share a published post or blog in an existing conversation',
  })
  @ApiCreatedResponse({ type: SendMessageResponseDto })
  shareToConversation(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SharePostDto,
  ): Promise<SendMessageResponseDto> {
    return this.messaging.sharePostToConversation(request.user.sub, id, dto);
  }
}
