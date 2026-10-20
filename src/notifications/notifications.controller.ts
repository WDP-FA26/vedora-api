import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { interval, map, merge, Observable } from 'rxjs';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CursorPaginationQueryDto } from '../common/pagination';
import { NotificationPageDto, UnreadCountDto } from './dto/notification.dto';
import { NotificationsService } from './notifications.service';

/** Proxies drop idle connections; a comment frame every 25s keeps it open. */
const HEARTBEAT_MS = 25_000;

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  // Declared before `:id/read` so `sse` is never read as an id.
  @Sse('sse')
  @ApiOperation({
    summary: 'Live notification stream (text/event-stream)',
    description:
      'Events: `notification` (data = NotificationDto) and a periodic `ping`. ' +
      'EventSource cannot send an Authorization header; read the stream with ' +
      'fetch() instead.',
  })
  stream(@Req() request: AuthenticatedRequest): Observable<MessageEvent> {
    const live = this.notifications
      .stream(request.user.sub)
      .pipe(map((data): MessageEvent => ({ type: 'notification', data })));
    const heartbeat = interval(HEARTBEAT_MS).pipe(
      map((): MessageEvent => ({ type: 'ping', data: {} })),
    );
    return merge(live, heartbeat);
  }

  @Get()
  @ApiOperation({ summary: 'List your notifications, newest first' })
  @ApiOkResponse({ type: NotificationPageDto })
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: CursorPaginationQueryDto,
  ): Promise<NotificationPageDto> {
    return this.notifications.list(request.user.sub, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Number of unread notifications' })
  @ApiOkResponse({ type: UnreadCountDto })
  unreadCount(@Req() request: AuthenticatedRequest): Promise<UnreadCountDto> {
    return this.notifications.unreadCount(request.user.sub);
  }

  @Post('read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark all notifications as read' })
  @ApiNoContentResponse()
  markAllRead(@Req() request: AuthenticatedRequest): Promise<void> {
    return this.notifications.markAllRead(request.user.sub);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark one notification as read' })
  @ApiNoContentResponse()
  markRead(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.notifications.markRead(request.user.sub, id);
  }
}
