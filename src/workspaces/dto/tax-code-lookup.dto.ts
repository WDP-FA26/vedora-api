import { ApiProperty } from '@nestjs/swagger';

export enum TaxCodeLookupStatus {
  FOUND = 'FOUND',
  NOT_FOUND = 'NOT_FOUND',
  NOT_APPLICABLE = 'NOT_APPLICABLE',
  UNAVAILABLE = 'UNAVAILABLE',
}

export class TaxCodeLookupDto {
  @ApiProperty({ enum: TaxCodeLookupStatus }) status!: TaxCodeLookupStatus;
  @ApiProperty({ type: String, nullable: true, example: '0101245486' })
  taxCode!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Registered name; set when FOUND',
  })
  officialName!: string | null;
  @ApiProperty({ type: String, nullable: true }) shortName!: string | null;
  @ApiProperty({ type: String, nullable: true }) address!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'NNT đang hoạt động',
    description: 'Status as the tax department words it',
  })
  taxStatus!: string | null;
  @ApiProperty({
    type: Boolean,
    nullable: true,
    description:
      'Whether the application legal name is the registered one (accents, case and legal-form words ignored); null unless FOUND',
  })
  nameMatches!: boolean | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'When the source last copied the tax department data',
  })
  sourceUpdatedAt!: string | null;
}
