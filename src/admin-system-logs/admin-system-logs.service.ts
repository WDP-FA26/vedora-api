import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, QueryFilter } from 'mongoose';
import {
  createPaginatedResponse,
  getPaginationArgs,
} from '../common/pagination/index.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { escapeRegExp } from '../common/text.js';
import { runtimeConfig } from '../config/runtime-config.js';
import { SystemLog } from '../mongo/models.js';
import { SystemLogDto, SystemLogQueryDto } from './system-log.dto.js';

export type SystemLogInput = Omit<SystemLog, 'id' | '_id' | 'createdAt'>;
const toDto = (row: SystemLog): SystemLogDto => ({
  id: row.id,
  requestId: row.requestId,
  actorId: row.actorId,
  actorUsername: row.actorUsername,
  action: row.action,
  actionLabel: row.actionLabel,
  resourceType: row.resourceType,
  targetId: row.targetId,
  method: row.method,
  route: row.route,
  outcome: row.outcome,
  httpStatus: row.httpStatus,
  errorCode: row.errorCode,
  durationMs: row.durationMs,
  decision: row.decision,
  targetStatus: row.targetStatus,
  targetRole: row.targetRole,
  createdAt: row.createdAt,
});

@Injectable()
export class AdminSystemLogsService {
  private readonly logger = new Logger(AdminSystemLogsService.name);
  constructor(
    @InjectModel(SystemLog.name) private readonly logs: Model<SystemLog>,
  ) {}

  async append(input: SystemLogInput): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.logs.create(input),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Audit write timed out')),
            runtimeConfig.SYSTEM_LOG_WRITE_TIMEOUT_MS,
          );
        }),
      ]);
    } catch {
      this.logger.warn(
        'System log write failed; requestId=' +
          input.requestId +
          '; action=' +
          input.action,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async findAll(query: SystemLogQueryDto) {
    if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to))
      throw new InvalidInputException(
        'BAD_REQUEST',
        'from must not be later than to',
      );
    const filter: QueryFilter<SystemLog> = {};
    for (const key of [
      'actorId',
      'targetId',
      'requestId',
      'outcome',
      'resourceType',
    ] as const)
      if (query[key]) filter[key] = query[key];
    if (query.from || query.to)
      filter.createdAt = {
        ...(query.from ? { $gte: new Date(query.from) } : {}),
        ...(query.to ? { $lte: new Date(query.to) } : {}),
      };
    if (query.q) {
      const pattern = { $regex: escapeRegExp(query.q), $options: 'i' };
      filter.$or = [
        'actorUsername',
        'actionLabel',
        'action',
        'targetId',
        'requestId',
      ].map((key) => ({ [key]: pattern }));
    }
    const { skip, take } = getPaginationArgs(query);
    const [rows, total] = await Promise.all([
      this.logs
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(take)
        .maxTimeMS(runtimeConfig.SYSTEM_LOG_QUERY_TIMEOUT_MS)
        .exec(),
      this.logs
        .countDocuments(filter)
        .maxTimeMS(runtimeConfig.SYSTEM_LOG_QUERY_TIMEOUT_MS)
        .exec(),
    ]);
    return createPaginatedResponse(rows.map(toDto), total, query);
  }

  async findOne(id: string): Promise<SystemLogDto> {
    const row = await this.logs
      .findById(id)
      .maxTimeMS(runtimeConfig.SYSTEM_LOG_QUERY_TIMEOUT_MS)
      .exec();
    if (!row)
      throw new ResourceNotFoundException('NOT_FOUND', 'System log not found');
    return toDto(row);
  }
}
