import { runtimeConfig } from '../config/runtime-config.js';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { Workspace } from '../mongo/models.js';
import {
  TaxCodeLookupDto,
  TaxCodeLookupStatus,
} from './dto/tax-code-lookup.dto.js';
import {
  isPublicTaxCode,
  legalNameMatches,
  VIETQR_FOUND,
  VIETQR_NOT_FOUND,
  vietQrBusinessSchema,
} from './tax-code-lookup.js';

const LOOKUP_URL = runtimeConfig.TAX_CODE_LOOKUP_URL;
const TIMEOUT_MS = runtimeConfig.TAX_CODE_LOOKUP_TIMEOUT_MS;
const CACHE_MS = runtimeConfig.TAX_CODE_LOOKUP_CACHE_SECONDS * 1000;

type Registration = Omit<TaxCodeLookupDto, 'nameMatches'>;

function emptyResult(
  status: TaxCodeLookupStatus,
  taxCode: string | null,
): Registration {
  return {
    status,
    taxCode,
    officialName: null,
    shortName: null,
    address: null,
    taxStatus: null,
    sourceUpdatedAt: null,
  };
}

@Injectable()
export class TaxCodeLookupService {
  private readonly logger = new Logger(TaxCodeLookupService.name);
  private readonly cache = new Map<
    string,
    { expiresAt: number; result: Registration }
  >();

  constructor(
    @InjectModel(Workspace.name)
    private readonly workspaces: Model<Workspace>,
  ) {}

  async forWorkspace(workspaceId: string): Promise<TaxCodeLookupDto> {
    const workspace = await this.workspaces
      .findOne({ _id: workspaceId })
      .select('legal')
      .exec();
    if (!workspace)
      throw new ResourceNotFoundException('NOT_FOUND', 'Page not found');

    const legal = workspace.legal;
    if (!legal || !isPublicTaxCode(legal.taxCode)) {
      return {
        ...emptyResult(
          TaxCodeLookupStatus.NOT_APPLICABLE,
          legal?.taxCode ?? null,
        ),
        nameMatches: null,
      };
    }

    const registration = await this.lookUp(legal.taxCode);
    let nameMatches: boolean | null = null;
    if (
      registration.status === TaxCodeLookupStatus.FOUND &&
      registration.officialName !== null &&
      legal.legalName
    ) {
      nameMatches = legalNameMatches(
        registration.officialName,
        legal.legalName,
      );
    }
    return { ...registration, nameMatches };
  }

  async lookUp(taxCode: string, now = Date.now()): Promise<Registration> {
    const cached = this.cache.get(taxCode);
    if (cached && cached.expiresAt > now) return cached.result;

    const result = await this.fetchRegistration(taxCode);
    if (result.status !== TaxCodeLookupStatus.UNAVAILABLE) {
      this.cache.set(taxCode, { expiresAt: now + CACHE_MS, result });
    }
    return result;
  }

  private async fetchRegistration(taxCode: string): Promise<Registration> {
    const url = `${LOOKUP_URL}/${encodeURIComponent(taxCode)}`;
    let body: unknown;
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`Tax code lookup answered ${response.status}`);
        return emptyResult(TaxCodeLookupStatus.UNAVAILABLE, taxCode);
      }
      body = await response.json();
    } catch (error) {
      this.logger.warn(`Tax code lookup failed: ${String(error)}`);
      return emptyResult(TaxCodeLookupStatus.UNAVAILABLE, taxCode);
    }

    const parsed = vietQrBusinessSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn('Tax code lookup returned an unexpected body');
      return emptyResult(TaxCodeLookupStatus.UNAVAILABLE, taxCode);
    }
    const { code, data, metadata } = parsed.data;
    if (code === VIETQR_NOT_FOUND) {
      return emptyResult(TaxCodeLookupStatus.NOT_FOUND, taxCode);
    }
    if (code !== VIETQR_FOUND || !data) {
      this.logger.warn(`Tax code lookup answered code ${code}`);
      return emptyResult(TaxCodeLookupStatus.UNAVAILABLE, taxCode);
    }
    return {
      status: TaxCodeLookupStatus.FOUND,
      taxCode,
      officialName: data.name,
      shortName: data.shortName ?? null,
      address: data.address ?? null,
      taxStatus: data.status ?? null,
      sourceUpdatedAt: metadata?.updatedAt ?? null,
    };
  }
}
