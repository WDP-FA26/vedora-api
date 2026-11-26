import { randomUUID } from 'node:crypto';
import { WorkspaceProof, WorkspaceProofKind } from '@src/mongo/models.js';
import type { MongoService } from '@src/mongo/mongo.service.js';

/** A complete 3-step page application for a household business, minus `proofIds`. */
export const PAGE_APPLICATION = {
  name: 'Chay An Lạc',
  username: 'chay.an.lac',
  bio: 'Quán chay gia đình',
  provinceCode: 'ha-noi',
  ward: 'Phường Hoàn Kiếm',
  address: '12 Hàng Bông',
  longitude: 105.8482,
  latitude: 21.0302,
  businessForm: 'EATERY',
  vegetarianLevel: 'VEGAN',
  phone: '0901 234 567',
  website: 'https://anlac.example',
  otherPlatformUrls: ['https://maps.google.com/?cid=1'],
  legal: {
    entityType: 'HOUSEHOLD',
    taxCode: '0123 456 789',
    legalName: 'Hộ kinh doanh Chay An Lạc',
    legalAddress: '12 Hàng Bông, Hoàn Kiếm, Hà Nội',
    representativeName: 'Nguyễn Văn An',
    contactEmail: 'an@anlac.example',
  },
  statement: 'Tôi là chủ quán.',
  confirmsAccuracy: true,
  consentsToReview: true,
};

/** The documents a household business must send. */
export const HOUSEHOLD_PROOF_KINDS = [
  WorkspaceProofKind.ID_FRONT,
  WorkspaceProofKind.ID_BACK,
  WorkspaceProofKind.STOREFRONT,
  WorkspaceProofKind.BUSINESS_LICENSE,
] as const;

/** An admin approval with every checklist item ticked. */
export const APPROVE_REVIEW = {
  decision: 'APPROVED',
  checklist: {
    identityMatches: true,
    taxCodeVerified: true,
    storefrontMatches: true,
    phoneConfirmed: true,
  },
};

/** Proof rows as if `ownerId` had uploaded one image of each kind; storage is faked by the caller. */
export async function uploadedProofs(
  db: MongoService,
  ownerId: string,
  kinds: readonly WorkspaceProofKind[] = HOUSEHOLD_PROOF_KINDS,
): Promise<string[]> {
  const ids: string[] = [];
  for (const kind of kinds) {
    const id = randomUUID();
    await db.connection.model<WorkspaceProof>(WorkspaceProof.name).create({
      _id: id,
      ownerId,
      storageKey: `workspaces/${ownerId}/${id}.jpg`,
      kind,
    });
    ids.push(id);
  }
  return ids;
}
