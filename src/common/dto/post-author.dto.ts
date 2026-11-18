import { ApiProperty } from '@nestjs/swagger';

export class PostAuthorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'vedora.user' })
  username!: string;

  @ApiProperty({ example: 'Vedora User' })
  fullName!: string;

  @ApiProperty({ nullable: true, type: String })
  avatarUrl!: string | null;

  /** Verified professional (chef badge). A trust signal only. */
  @ApiProperty()
  isProfessional!: boolean;
}
