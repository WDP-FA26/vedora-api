import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { BillingPlan, SubscriptionCatalog } from '../mongo/models.js';
import { isUniqueViolation } from '../mongo/errors.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';
import {
  PAID_PLANS,
  PLAN_VERSION,
  SUBSCRIPTION_LIMITS,
} from './subscription-policy.js';
import {
  AdminSubscriptionCatalogDto,
  UpdateSubscriptionCatalogDto,
} from './subscription-catalog.dto.js';

const CATALOG_ID = '9fd37843-83f6-48a4-ad66-012caec15136';

@Injectable()
export class SubscriptionCatalogService {
  constructor(
    @InjectModel(SubscriptionCatalog.name)
    private readonly model: Model<SubscriptionCatalog>,
    private readonly config: ConfigService,
  ) {}

  /** No process cache: purchases and Free quota read committed shared settings. */
  async current(session?: ClientSession): Promise<AdminSubscriptionCatalogDto> {
    const row = await this.model
      .findById(CATALOG_ID)
      .session(session ?? null)
      .exec();
    return this.serialize(row);
  }

  private serialize(
    row: SubscriptionCatalog | null,
  ): AdminSubscriptionCatalogDto {
    return {
      id: CATALOG_ID,
      version: row?.version ?? 0,
      source: row ? 'DATABASE' : 'ENV',
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedById: row?.updatedById ?? null,
      planVersion: PLAN_VERSION,
      paymentsEnabled: this.config.get<boolean>('SEPAY_PAYMENT_ENABLED', false),
      freeLimits: {
        textLimit: row?.freeLimits.textLimit ?? SUBSCRIPTION_LIMITS.FREE.text,
        imageLimit:
          row?.freeLimits.imageLimit ?? SUBSCRIPTION_LIMITS.FREE.images,
      },
      plans: PAID_PLANS.map((code) => {
        const stored = row?.plans.find((plan) => plan.code === code);
        return {
          code,
          name: code === BillingPlan.PLUS ? 'Plus' : 'Pro',
          priceVnd: String(
            stored?.priceVnd ??
              this.config.get<number>(
                `SUBSCRIPTION_${code}_PRICE_VND`,
                code === BillingPlan.PLUS ? 49000 : 99000,
              ),
          ),
          durationDays: this.config.get<number>('BILLING_DURATION_DAYS', 30),
          textLimit: stored?.textLimit ?? SUBSCRIPTION_LIMITS[code].text,
          imageLimit: stored?.imageLimit ?? SUBSCRIPTION_LIMITS[code].images,
        };
      }),
    };
  }

  async update(
    input: UpdateSubscriptionCatalogDto,
    actorId: string,
  ): Promise<AdminSubscriptionCatalogDto> {
    const fields = {
      freeLimits: {
        textLimit: input.freeLimits.textLimit,
        imageLimit: input.freeLimits.imageLimit,
      },
      plans: input.plans.map(({ code, priceVnd, textLimit, imageLimit }) => ({
        code,
        priceVnd,
        textLimit,
        imageLimit,
      })),
      updatedById: actorId,
    };
    if (input.version === 0) {
      try {
        const row = await this.model.create({
          _id: CATALOG_ID,
          version: 1,
          ...fields,
        });
        return this.serialize(row);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        throw this.conflict();
      }
    }
    const row = await this.model
      .findOneAndUpdate(
        { _id: CATALOG_ID, version: input.version },
        { $set: fields, $inc: { version: 1 } },
        { returnDocument: 'after', runValidators: true },
      )
      .exec();
    if (!row) throw this.conflict();
    return this.serialize(row);
  }

  private conflict(): StateConflictException {
    return new StateConflictException(
      'SUBSCRIPTION_CATALOG_CONFLICT',
      'Subscription plans changed; reload the latest version before saving',
    );
  }
}
