import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('app')
@Controller()
export class AppController {
  @Get()
  @ApiOperation({ summary: 'API information' })
  getInfo(): { name: string; version: string; docs: string } {
    return {
      name: 'Vedora API',
      version: '0.1.0',
      docs: '/docs',
    };
  }
}
