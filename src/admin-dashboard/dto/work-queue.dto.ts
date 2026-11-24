import { ApiProperty } from '@nestjs/swagger';

export const ADMIN_WORK_KINDS = [
  'POST_REVIEW',
  'POST_REPORTS',
  'COMMENT_REPORTS',
  'VERIFICATION',
  'WORKSPACES',
  'SUPPORT',
  'KNOWLEDGE',
] as const;
export type AdminWorkKind = (typeof ADMIN_WORK_KINDS)[number];

export class AdminWorkCountsDto {
  @ApiProperty() POST_REVIEW!: number;
  @ApiProperty() POST_REPORTS!: number;
  @ApiProperty() COMMENT_REPORTS!: number;
  @ApiProperty() VERIFICATION!: number;
  @ApiProperty() WORKSPACES!: number;
  @ApiProperty() SUPPORT!: number;
  @ApiProperty() KNOWLEDGE!: number;
}
export class AdminWorkBadgesDto {
  @ApiProperty() total!: number;
  @ApiProperty() moderation!: number;
  @ApiProperty() verification!: number;
  @ApiProperty() workspaces!: number;
  @ApiProperty() support!: number;
  @ApiProperty() knowledge!: number;
}
export class AdminSupportWorkDto {
  @ApiProperty() appeals!: number;
  @ApiProperty() assignedToMe!: number;
}
export class AdminWorkItemDto {
  @ApiProperty({ enum: ADMIN_WORK_KINDS }) kind!: AdminWorkKind;
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: Date, nullable: true }) createdAt!: Date | null;
  @ApiProperty({ minimum: 1 }) sourceCount!: number;
}
export class AdminWorkQueueDto {
  @ApiProperty() generatedAt!: Date;
  @ApiProperty() refreshAfterSeconds!: number;
  @ApiProperty() previewLimit!: number;
  @ApiProperty({ type: AdminWorkCountsDto }) counts!: AdminWorkCountsDto;
  @ApiProperty({ type: AdminWorkBadgesDto }) badges!: AdminWorkBadgesDto;
  @ApiProperty({ type: AdminSupportWorkDto }) support!: AdminSupportWorkDto;
  @ApiProperty({ type: [AdminWorkItemDto] }) items!: AdminWorkItemDto[];
}
