import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MongoService } from '../mongo/mongo.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly mongo: MongoService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness check' })
  live(): { status: string; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness check including MongoDB' })
  async ready(): Promise<{ status: string; database: string }> {
    await this.mongo.db.admin().command({ ping: 1 });
    return { status: 'ok', database: 'up' };
  }
}
