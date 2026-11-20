import { ApiProperty } from '@nestjs/swagger';
import { AppealOutcome, SupportTicketStatus } from '../../mongo/models.js';
import {
  APPEAL_BLOCKED_REASONS,
  type AppealBlockedReason,
} from '../support-policy.js';

export class PostAppealTicketRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'APL-8F2K9C' })
  code!: string;

  @ApiProperty({ enum: SupportTicketStatus })
  status!: SupportTicketStatus;

  @ApiProperty({ nullable: true, enum: AppealOutcome })
  outcome!: AppealOutcome | null;

  @ApiProperty({ nullable: true, type: Date })
  resolvedAt!: Date | null;
}

export class PostAppealSummaryDto {
  @ApiProperty({ nullable: true, type: PostAppealTicketRefDto })
  activeTicket!: PostAppealTicketRefDto | null;

  @ApiProperty({ nullable: true, type: PostAppealTicketRefDto })
  latestTicket!: PostAppealTicketRefDto | null;

  @ApiProperty()
  canAppeal!: boolean;

  @ApiProperty({ nullable: true, type: Date })
  deadlineAt!: Date | null;

  @ApiProperty({ nullable: true, enum: APPEAL_BLOCKED_REASONS })
  blockedReason!: AppealBlockedReason | null;
}
