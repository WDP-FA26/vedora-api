import {
  Controller,
  Header,
  MessageEvent,
  Param,
  ParseUUIDPipe,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  exhaustMap,
  interval,
  map,
  merge,
  Observable,
  takeWhile,
  takeUntil,
} from 'rxjs';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentEventsService } from './payment-events.service';
import { PaymentsService } from './payments.service';

@ApiTags('billing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('payment-intents')
export class PaymentStreamController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly events: PaymentEventsService,
    private readonly db: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  @Sse(':id/events')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @Header('X-Accel-Buffering', 'no')
  @ApiOperation({
    summary: 'Owner-only payment invalidations over SSE',
    description:
      'Use fetch with Authorization, not a token in the URL. Events: stream.ready, stream.unavailable, payment.changed, ping, session.expired. Always GET payment after connection/event; events never establish paid state. Heartbeat rechecks JWT/account every 15s.',
  })
  @ApiNotFoundResponse({
    description: 'Payment missing or owned by another account',
  })
  async stream(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Observable<MessageEvent>> {
    await this.payments.get(id, request.user.sub);
    const token = request.headers.authorization!.split(' ')[1];
    const live = this.events
      .stream(request.user.sub, id)
      .pipe(
        map((signal): MessageEvent =>
          signal.type === 'changed'
            ? { type: 'payment.changed', data: { intentId: signal.intentId } }
            : { type: `stream.${signal.type}`, data: {} },
        ),
      );
    const heartbeat = interval(15_000).pipe(
      exhaustMap(async (): Promise<MessageEvent> => {
        try {
          await this.jwt.verifyAsync(token);
        } catch {
          return { type: 'session.expired', data: {} };
        }
        try {
          const user = await this.db.user.findUnique({
            where: { id: request.user.sub },
            select: { status: true },
          });
          if (!user || user.status !== 'ACTIVE')
            return { type: 'session.expired', data: {} };
          return {
            type: 'ping',
            data: { connected: this.events.isConnected() },
          };
        } catch {
          return { type: 'stream.unavailable', data: {} };
        }
      }),
    );
    return merge(live, heartbeat).pipe(
      takeUntil(this.events.closed$),
      takeWhile((event) => event.type !== 'session.expired', true),
    );
  }
}
