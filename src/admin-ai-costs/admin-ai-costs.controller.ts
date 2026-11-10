import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth-core/jwt-auth.guard.js';
import { RolesGuard } from '../auth-core/roles.guard.js';
import { Roles } from '../auth-core/roles.decorator.js';
import { UserRole } from '../mongo/models.js';
import { AdminAiCostsService } from './admin-ai-costs.service.js';
import { AiCostCallsQueryDto, AiCostQueryDto } from './ai-cost-query.dto.js';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/ai-costs')
export class AdminAiCostsController {
  constructor(private readonly costs: AdminAiCostsService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary:
      'Measured OpenRouter USD spend; missing costs stay unknown; Bangkok range up to 90 days',
  })
  report(@Query() query: AiCostQueryDto) {
    return this.costs.report(query);
  }
  @Get('calls')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary: 'Paginated billing metadata only; no prompts or API keys',
  })
  list(@Query() query: AiCostCallsQueryDto) {
    return this.costs.list(query);
  }
  @Get('export')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: 'CSV of up to 10000 matching attempts; narrow filters if exceeded',
  })
  async csv(@Query() query: AiCostQueryDto, @Res() response: Response) {
    const csv = await this.costs.csv(query);
    response.type('text/csv').attachment('vedora-ai-costs.csv').send(csv);
  }
  @Post('calls/:id/reconcile')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary:
      'Look up a missing charge by stored generation ID; no inference or pricing estimate',
  })
  reconcile(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.costs.reconcile(id);
  }
}
