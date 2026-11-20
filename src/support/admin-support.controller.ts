import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth-core/auth.types.js';
import { JwtAuthGuard } from '../auth-core/jwt-auth.guard.js';
import { Roles } from '../auth-core/roles.decorator.js';
import { RolesGuard } from '../auth-core/roles.guard.js';
import { ErrorBodyDto } from '../common/exceptions/error-body.dto.js';
import { UserRole } from '../mongo/models.js';
import { AdminSupportService } from './admin-support.service.js';
import {
  AdminCreateSupportMessageDto,
  AdminListTicketsQueryDto,
  AdminSupportTicketDetailDto,
  AdminSupportTicketsPageDto,
  ClaimSupportTicketDto,
  ResolveSupportTicketDto,
} from './dto/support.dto.js';

@ApiTags('admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ErrorBodyDto,
  description: 'Authentication required',
})
@ApiForbiddenResponse({
  type: ErrorBodyDto,
  description: 'Insufficient account permissions',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/support/tickets')
export class AdminSupportController {
  constructor(private readonly adminSupport: AdminSupportService) {}

  @Get()
  @ApiOperation({
    summary: 'List support tickets with status and category counts',
    description:
      'Orders OPEN and WAITING_USER queues FIFO by lastMessageAt; other views newest updated first.',
  })
  @ApiOkResponse({ type: AdminSupportTicketsPageDto })
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: AdminListTicketsQueryDto,
  ): Promise<AdminSupportTicketsPageDto> {
    return this.adminSupport.list(query, request.user.sub);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Get a support ticket with all messages (including internal notes) and full post details when CONTENT_APPEAL',
  })
  @ApiOkResponse({ type: AdminSupportTicketDetailDto })
  @ApiNotFoundResponse({ type: ErrorBodyDto })
  getOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminSupportTicketDetailDto> {
    return this.adminSupport.getOne(id);
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reply to the user or add an internal admin note',
    description:
      'Public replies need an active ticket you hold (or nobody holds; replying claims it), move it to WAITING_USER and send SUPPORT_TICKET_REPLIED. Internal notes work on any ticket, by any admin, and do not notify the user or change status.',
  })
  @ApiOkResponse({ type: AdminSupportTicketDetailDto })
  @ApiConflictResponse({ type: ErrorBodyDto })
  reply(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminCreateSupportMessageDto,
  ): Promise<AdminSupportTicketDetailDto> {
    return this.adminSupport.reply(id, request.user.sub, dto);
  }

  @Post(':id/claim')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Claim an active ticket so only you reply to and resolve it',
    description:
      'Answers 409 TICKET_CLAIMED_BY_OTHER when another admin holds it, unless force is true. Replying to or resolving an unclaimed ticket also claims it.',
  })
  @ApiOkResponse({ type: AdminSupportTicketDetailDto })
  @ApiConflictResponse({ type: ErrorBodyDto })
  claim(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ClaimSupportTicketDto,
  ): Promise<AdminSupportTicketDetailDto> {
    return this.adminSupport.claim(id, request.user.sub, dto);
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Release a ticket you claimed back to the queue' })
  @ApiOkResponse({ type: AdminSupportTicketDetailDto })
  @ApiConflictResponse({ type: ErrorBodyDto })
  release(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminSupportTicketDetailDto> {
    return this.adminSupport.release(id, request.user.sub);
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve or close an active support ticket',
    description:
      'CONTENT_APPEAL uses APPROVE/REJECT; other categories use RESOLVE/CLOSE. REJECT and CLOSE require a note of at least 5 characters.',
  })
  @ApiOkResponse({ type: AdminSupportTicketDetailDto })
  @ApiConflictResponse({ type: ErrorBodyDto })
  resolve(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveSupportTicketDto,
  ): Promise<AdminSupportTicketDetailDto> {
    return this.adminSupport.resolve(id, request.user.sub, dto);
  }
}
