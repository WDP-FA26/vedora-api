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
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth-core/auth.types.js';
import { JwtAuthGuard } from '../auth-core/jwt-auth.guard.js';
import { ErrorBodyDto } from '../common/exceptions/error-body.dto.js';
import {
  ApiPaginatedResponse,
  type PaginatedResponseDto,
} from '../common/pagination/index.js';
import {
  CreateSupportMessageDto,
  CreateSupportTicketDto,
  ListMyTicketsQueryDto,
  SupportTicketDetailDto,
  SupportTicketListItemDto,
} from './dto/support.dto.js';
import { SupportService } from './support.service.js';

@ApiTags('support')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ErrorBodyDto,
  description: 'Authentication required',
})
@UseGuards(JwtAuthGuard)
@Controller('support/tickets')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post()
  @ApiOperation({
    summary:
      'Open a support ticket (content appeal, payment, verification, or general)',
    description:
      'CONTENT_APPEAL tickets require postId (within 14 days of rejection or admin removal) and lock post editing/deletion until closed. Other categories require a subject.',
  })
  @ApiCreatedResponse({ type: SupportTicketDetailDto })
  @ApiConflictResponse({ type: ErrorBodyDto })
  @ApiForbiddenResponse({ type: ErrorBodyDto })
  @ApiNotFoundResponse({ type: ErrorBodyDto })
  create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateSupportTicketDto,
  ): Promise<SupportTicketDetailDto> {
    return this.support.create(request.user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List my support tickets, newest updated first' })
  @ApiPaginatedResponse(SupportTicketListItemDto)
  listMine(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListMyTicketsQueryDto,
  ): Promise<PaginatedResponseDto<SupportTicketListItemDto>> {
    return this.support.listMine(request.user.sub, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one of my support tickets with its public correspondence log',
  })
  @ApiOkResponse({ type: SupportTicketDetailDto })
  @ApiForbiddenResponse({ type: ErrorBodyDto })
  @ApiNotFoundResponse({ type: ErrorBodyDto })
  getOne(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SupportTicketDetailDto> {
    return this.support.getOne(id, request.user.sub);
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reply to an active support ticket',
    description:
      'Moves a WAITING_USER ticket back to OPEN. Replying to a finished non-appeal ticket within SUPPORT_REOPEN_WINDOW_DAYS of its closure reopens it.',
  })
  @ApiOkResponse({ type: SupportTicketDetailDto })
  @ApiConflictResponse({ type: ErrorBodyDto })
  reply(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateSupportMessageDto,
  ): Promise<SupportTicketDetailDto> {
    return this.support.reply(id, request.user.sub, dto);
  }

  @Post(':id/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw an active support ticket',
    description:
      'Closes the ticket as WITHDRAWN and unlocks post editing if it was a CONTENT_APPEAL.',
  })
  @ApiOkResponse({ type: SupportTicketDetailDto })
  @ApiConflictResponse({ type: ErrorBodyDto })
  withdraw(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SupportTicketDetailDto> {
    return this.support.withdraw(id, request.user.sub);
  }
}
