import { ApiProperty } from '@nestjs/swagger';

export class BlogRecipeRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true, type: String }) imageUrl!: string | null;
}

export class BlogSummaryDto {
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true, type: String }) coverImageUrl!: string | null;
  @ApiProperty({ description: 'Plain source-text preview, not HTML' })
  excerpt!: string;
  @ApiProperty({ type: [BlogRecipeRefDto] }) recipes!: BlogRecipeRefDto[];
}
