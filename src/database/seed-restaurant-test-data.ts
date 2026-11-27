import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import {
  DeleteObjectsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { hash } from 'bcryptjs';
import mongoose, { type Connection } from 'mongoose';
import {
  AccountStatus,
  AccountType,
  BusinessForm,
  LegalEntityType,
  UserRole,
  VegetarianLevel,
  VerificationStatus,
  WorkspaceMemberRole,
  WorkspaceProofKind,
  WorkspaceRejectReason,
  type WorkspaceLegal,
} from '../mongo/models.js';
import { registerModels } from '../mongo/schemas/model-definitions.js';
import { wardName, type VnProvinceCode } from '../workspaces/vn-admin-units.js';

const SEED_EMAIL_DOMAIN = 'seed.vedora.test';
const DAY_MS = 24 * 3600 * 1000;

type ProofSpec = { kind: WorkspaceProofKind; caption: string };

type ApplicationSpec = {
  owner: string;
  name: string;
  username: string;
  bio: string;
  provinceCode: VnProvinceCode;
  wardCode: string;
  address: string;
  longitude: number;
  latitude: number;
  businessForm: BusinessForm;
  vegetarianLevel: VegetarianLevel;
  phone: string;
  otherPlatformUrls: string[];
  legal: WorkspaceLegal | null;
  statement: string | null;
  proofs: ProofSpec[];
  status: VerificationStatus;
  rejectReason?: WorkspaceRejectReason;
  reviewNote?: string;
  daysAgo: number;
};

type AccountSpec = { username: string; fullName: string };

const ACCOUNTS: AccountSpec[] = [
  { username: 'test.chuquan.anh', fullName: 'Trần Minh Anh' },
  { username: 'test.chuquan.binh', fullName: 'Lê Thu Bình' },
  { username: 'test.chuquan.cuong', fullName: 'Phạm Gia Cường' },
  { username: 'test.chuquan.dung', fullName: 'Võ Thị Dung' },
  { username: 'test.chuquan.em', fullName: 'Đặng Quốc Em' },
  { username: 'test.chuquan.phuong', fullName: 'Hồ Thanh Phương' },
  { username: 'test.nguoimoi', fullName: 'Ngô Mới Tạo' },
];

const HOUSEHOLD_PROOFS: ProofSpec[] = [
  { kind: WorkspaceProofKind.ID_FRONT, caption: 'CCCD mặt trước' },
  { kind: WorkspaceProofKind.ID_BACK, caption: 'CCCD mặt sau' },
  { kind: WorkspaceProofKind.STOREFRONT, caption: 'Mặt tiền quán' },
  {
    kind: WorkspaceProofKind.BUSINESS_LICENSE,
    caption: 'Giấy chứng nhận đăng ký kinh doanh',
  },
];

const INDIVIDUAL_PROOFS: ProofSpec[] = HOUSEHOLD_PROOFS.slice(0, 3);

const APPLICATIONS: ApplicationSpec[] = [
  {
    owner: 'test.chuquan.anh',
    name: 'Chay Hoa Sen - Cơm chay - Lý Thường Kiệt',
    username: 'test-chay-hoa-sen',
    bio: 'Quán cơm chay gia đình, mở cửa 6h–21h.',
    provinceCode: '01',
    wardCode: '00082',
    address: '12 Lý Thường Kiệt',
    longitude: 105.8452,
    latitude: 21.0247,
    businessForm: BusinessForm.EATERY,
    vegetarianLevel: VegetarianLevel.VEGAN,
    phone: '0900 000 001',
    otherPlatformUrls: ['https://maps.google.com/?q=Chay+Hoa+Sen+test'],
    legal: {
      entityType: LegalEntityType.HOUSEHOLD,
      taxCode: '9900000001',
      legalName: 'Hộ kinh doanh Chay Hoa Sen (TEST)',
      legalAddress: '12 Lý Thường Kiệt, Cửa Nam, Hà Nội',
      representativeName: 'Trần Minh Anh',
      contactEmail: `test.chuquan.anh@${SEED_EMAIL_DOMAIN}`,
    },
    statement: 'Tôi là chủ quán.',
    proofs: HOUSEHOLD_PROOFS,
    status: VerificationStatus.APPROVED,
    daysAgo: 20,
  },
  {
    owner: 'test.chuquan.binh',
    name: 'Chay Hoa Sen 2 - Lẩu nấm - Lý Thường Kiệt',
    username: 'test-chay-hoa-sen-2',
    bio: 'Chi nhánh lẩu nấm.',
    provinceCode: '01',
    wardCode: '00082',
    address: '16 Lý Thường Kiệt',
    longitude: 105.8456,
    latitude: 21.025,
    businessForm: BusinessForm.RESTAURANT,
    vegetarianLevel: VegetarianLevel.VEGAN,
    phone: '0900 000 002',
    otherPlatformUrls: [],
    legal: {
      entityType: LegalEntityType.COMPANY,
      taxCode: '9900000001',
      legalName: 'Công ty TNHH Hoa Sen Chay (TEST)',
      legalAddress: '16 Lý Thường Kiệt, Cửa Nam, Hà Nội',
      representativeName: 'Lê Thu Bình',
      contactEmail: `test.chuquan.binh@${SEED_EMAIL_DOMAIN}`,
    },
    statement: 'Quản lý chi nhánh 2.',
    proofs: HOUSEHOLD_PROOFS,
    status: VerificationStatus.PENDING,
    daysAgo: 1,
  },
  {
    owner: 'test.chuquan.cuong',
    name: 'An Nhiên Chay - Bún Huế - Lê Thánh Tôn',
    username: 'test-an-nhien-chay',
    bio: 'Bún Huế chay, cơm tấm chay.',
    provinceCode: '79',
    wardCode: '26743',
    address: '88 Lê Thánh Tôn',
    longitude: 106.7004,
    latitude: 10.7745,
    businessForm: BusinessForm.EATERY,
    vegetarianLevel: VegetarianLevel.LACTO_OVO,
    phone: '0900 000 003',
    otherPlatformUrls: [
      'https://shopeefood.vn/test-an-nhien-chay',
      'https://facebook.com/test-an-nhien-chay',
    ],
    legal: {
      entityType: LegalEntityType.HOUSEHOLD,
      taxCode: '079200000003',
      legalName: 'Hộ kinh doanh An Nhiên Chay (TEST)',
      legalAddress: '88 Lê Thánh Tôn, Bến Thành, TP.HCM',
      representativeName: 'Phạm Gia Cường',
      contactEmail: `test.chuquan.cuong@${SEED_EMAIL_DOMAIN}`,
    },
    statement: 'Chủ hộ kinh doanh.',
    proofs: [
      ...HOUSEHOLD_PROOFS,
      {
        kind: WorkspaceProofKind.FOOD_SAFETY,
        caption: 'Giấy chứng nhận ATTP',
      },
      { kind: WorkspaceProofKind.MENU, caption: 'Thực đơn' },
    ],
    status: VerificationStatus.PENDING,
    daysAgo: 2,
  },
  {
    owner: 'test.chuquan.dung',
    name: 'Xe chè chay cô Dung',
    username: 'test-che-co-dung-cu',
    bio: 'Chè chay bán buổi chiều.',
    provinceCode: '46',
    wardCode: '19789',
    address: 'Đầu hẻm 5 Lê Lợi',
    longitude: 107.5862,
    latitude: 16.4637,
    businessForm: BusinessForm.STALL,
    vegetarianLevel: VegetarianLevel.VEGAN,
    phone: '0900 000 004',
    otherPlatformUrls: [],
    legal: {
      entityType: LegalEntityType.INDIVIDUAL,
      taxCode: '046200000004',
      legalName: null,
      legalAddress: '5 Lê Lợi, Thuận Hóa, Huế',
      representativeName: 'Võ Thị Dung',
      contactEmail: `test.chuquan.dung@${SEED_EMAIL_DOMAIN}`,
    },
    statement: null,
    proofs: INDIVIDUAL_PROOFS,
    status: VerificationStatus.REJECTED,
    rejectReason: WorkspaceRejectReason.BLURRY_DOCUMENTS,
    reviewNote: 'Ảnh CCCD bị mờ, chụp lại giúp mình nhé.',
    daysAgo: 10,
  },
  {
    owner: 'test.chuquan.dung',
    name: 'Xe chè chay cô Dung - Chè đậu - Lê Lợi',
    username: 'test-che-co-dung',
    bio: 'Chè đậu, chè khúc bạch chay.',
    provinceCode: '46',
    wardCode: '19789',
    address: 'Đầu hẻm 5 Lê Lợi',
    longitude: 107.5862,
    latitude: 16.4637,
    businessForm: BusinessForm.STALL,
    vegetarianLevel: VegetarianLevel.VEGAN,
    phone: '0900 000 004',
    otherPlatformUrls: [],
    legal: {
      entityType: LegalEntityType.INDIVIDUAL,
      taxCode: '046200000004',
      legalName: null,
      legalAddress: '5 Lê Lợi, Thuận Hóa, Huế',
      representativeName: 'Võ Thị Dung',
      contactEmail: `test.chuquan.dung@${SEED_EMAIL_DOMAIN}`,
    },
    statement: 'Gửi lại với ảnh rõ hơn.',
    proofs: INDIVIDUAL_PROOFS,
    status: VerificationStatus.PENDING,
    daysAgo: 0,
  },
  {
    owner: 'test.chuquan.em',
    name: 'Bếp Chay Em - Cơm phần - Hải Châu',
    username: 'test-bep-chay-em',
    bio: 'Cơm phần chay giao văn phòng.',
    provinceCode: '48',
    wardCode: '20242',
    address: '20 Bạch Đằng',
    longitude: 108.2244,
    latitude: 16.0718,
    businessForm: BusinessForm.ONLINE,
    vegetarianLevel: VegetarianLevel.VEGETARIAN_MENU,
    phone: '0900 000 005',
    otherPlatformUrls: [],
    legal: {
      entityType: LegalEntityType.HOUSEHOLD,
      taxCode: '9900000005',
      legalName: 'Hộ kinh doanh Bếp Chay Em (TEST)',
      legalAddress: '20 Bạch Đằng, Hải Châu, Đà Nẵng',
      representativeName: 'Đặng Quốc Em',
      contactEmail: `test.chuquan.em@${SEED_EMAIL_DOMAIN}`,
    },
    statement: 'Chủ bếp.',
    proofs: HOUSEHOLD_PROOFS,
    status: VerificationStatus.REJECTED,
    rejectReason: WorkspaceRejectReason.TAX_CODE_MISMATCH,
    reviewNote: 'Mã số thuế tra cứu ra tên hộ khác, kiểm tra lại giúp mình.',
    daysAgo: 3,
  },
  {
    owner: 'test.chuquan.phuong',
    name: 'Quán Chay Phương',
    username: 'test-quan-chay-phuong',
    bio: 'Quán chay nhỏ gần bến Ninh Kiều.',
    provinceCode: '92',
    wardCode: '31135',
    address: '3 Hai Bà Trưng',
    longitude: 105.7876,
    latitude: 10.0333,
    businessForm: BusinessForm.EATERY,
    vegetarianLevel: VegetarianLevel.VEGAN,
    phone: '0900 000 006',
    otherPlatformUrls: [],
    legal: null,
    statement: 'Tôi là chủ quán, gửi kèm giấy phép kinh doanh và ảnh quán.',
    proofs: [
      { kind: WorkspaceProofKind.OTHER, caption: 'Giấy phép (mẫu cũ)' },
      { kind: WorkspaceProofKind.OTHER, caption: 'Ảnh quán (mẫu cũ)' },
    ],
    status: VerificationStatus.PENDING,
    daysAgo: 6,
  },
];

const PROOF_COLORS: Record<WorkspaceProofKind, string> = {
  [WorkspaceProofKind.ID_FRONT]: '#2f5233',
  [WorkspaceProofKind.ID_BACK]: '#4b6e47',
  [WorkspaceProofKind.STOREFRONT]: '#7a5c3a',
  [WorkspaceProofKind.BUSINESS_LICENSE]: '#36507a',
  [WorkspaceProofKind.FOOD_SAFETY]: '#7a3650',
  [WorkspaceProofKind.MENU]: '#6b5b8a',
  [WorkspaceProofKind.OTHER]: '#555555',
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1')
    throw new Error(
      `DATABASE_URL points at ${host}; restaurant test data is for a local database only.`,
    );
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function proofImage(proof: ProofSpec, owner: string): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="520" viewBox="0 0 800 520">
  <rect width="800" height="520" fill="${PROOF_COLORS[proof.kind]}"/>
  <rect x="24" y="24" width="752" height="472" fill="none" stroke="#ffffff" stroke-opacity="0.5" stroke-width="4" stroke-dasharray="16 12"/>
  <text x="400" y="200" fill="#ffffff" font-family="Arial, sans-serif" font-size="44" font-weight="700" text-anchor="middle">${escapeXml(proof.caption)}</text>
  <text x="400" y="270" fill="#ffffff" font-family="Arial, sans-serif" font-size="30" text-anchor="middle">${escapeXml(owner)}</text>
  <text x="400" y="380" fill="#ffffff" fill-opacity="0.8" font-family="Arial, sans-serif" font-size="26" text-anchor="middle">ẢNH TEST — KHÔNG PHẢI GIẤY TỜ THẬT</text>
</svg>`;
  return Buffer.from(svg, 'utf8');
}

function storageClient(): S3Client {
  return new S3Client({
    endpoint: required('STORAGE_ENDPOINT'),
    region: process.env.STORAGE_REGION || 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: required('STORAGE_ACCESS_KEY'),
      secretAccessKey: required('STORAGE_SECRET_KEY'),
    },
  });
}

async function removePreviousRun(
  connection: Connection,
  storage: S3Client,
  bucket: string,
): Promise<void> {
  const users = connection.model('User');
  const members = connection.model('WorkspaceMember');
  const workspaces = connection.model('Workspace');
  const proofs = connection.model('WorkspaceProof');

  const seeded = await users
    .find({
      email: { $regex: `@${SEED_EMAIL_DOMAIN.replaceAll('.', '\\.')}$` },
    })
    .select('_id')
    .lean<{ _id: string }[]>()
    .exec();
  const userIds = seeded.map(({ _id }) => _id);
  const memberships = await members
    .find({ userId: { $in: userIds } })
    .select('workspaceId')
    .lean<{ workspaceId: string }[]>()
    .exec();
  const workspaceIds = memberships.map(({ workspaceId }) => workspaceId);
  const pages = await workspaces
    .find({ _id: { $in: workspaceIds }, pageUserId: { $type: 'string' } })
    .select('pageUserId')
    .lean<{ pageUserId: string }[]>()
    .exec();
  const oldProofs = await proofs
    .find({ workspaceId: { $in: workspaceIds } })
    .select('storageKey')
    .lean<{ storageKey: string }[]>()
    .exec();

  if (oldProofs.length > 0) {
    await storage.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: oldProofs.map(({ storageKey }) => ({ Key: storageKey })),
        },
      }),
    );
  }
  await proofs.deleteMany({ workspaceId: { $in: workspaceIds } });
  await members.deleteMany({ workspaceId: { $in: workspaceIds } });
  await workspaces.deleteMany({ _id: { $in: workspaceIds } });
  await users.deleteMany({
    _id: { $in: [...userIds, ...pages.map(({ pageUserId }) => pageUserId)] },
  });
}

async function createAccounts(
  connection: Connection,
  passwordHash: string,
): Promise<Map<string, string>> {
  const users = connection.model('User');
  const ids = new Map<string, string>();
  for (const account of ACCOUNTS) {
    const id = randomUUID();
    await users.create({
      _id: id,
      username: account.username,
      passwordHash,
      email: `${account.username}@${SEED_EMAIL_DOMAIN}`,
      fullName: account.fullName,
      role: UserRole.USER,
      status: AccountStatus.ACTIVE,
      accountType: AccountType.PERSONAL,
      emailVerifiedAt: new Date(),
      accountVersion: 0,
      isProfessional: false,
    });
    ids.set(account.username, id);
  }
  return ids;
}

async function createApplication(
  connection: Connection,
  storage: S3Client,
  bucket: string,
  spec: ApplicationSpec,
  ownerId: string,
  ownerName: string,
): Promise<void> {
  const workspaceId = randomUUID();
  const sentAt = new Date(Date.now() - spec.daysAgo * DAY_MS);
  const reviewed = spec.status !== VerificationStatus.PENDING;
  const approved = spec.status === VerificationStatus.APPROVED;
  const reviewedAt = reviewed
    ? new Date(sentAt.getTime() + 6 * 3600 * 1000)
    : null;

  let pageUserId: string | null = null;
  if (approved) {
    pageUserId = randomUUID();
    await connection.model('User').create({
      _id: pageUserId,
      username: spec.username,
      fullName: spec.name,
      bio: spec.bio,
      email: `page-${workspaceId}@pages.vedora.invalid`,
      passwordHash: null,
      googleId: null,
      role: UserRole.USER,
      status: AccountStatus.ACTIVE,
      accountType: AccountType.PAGE,
      accountVersion: 0,
      isProfessional: false,
      emailVerifiedAt: reviewedAt,
    });
  }

  await connection.model('Workspace').create({
    _id: workspaceId,
    pageUserId,
    username: spec.username,
    name: spec.name,
    bio: spec.bio,
    address: spec.address,
    location: {
      type: 'Point',
      coordinates: [spec.longitude, spec.latitude],
    },
    phone: spec.phone,
    website: null,
    provinceCode: spec.provinceCode,
    wardCode: spec.legal ? spec.wardCode : null,
    ward: wardName(spec.provinceCode, spec.wardCode),
    businessForm: spec.legal ? spec.businessForm : null,
    vegetarianLevel: spec.legal ? spec.vegetarianLevel : null,
    otherPlatformUrls: spec.otherPlatformUrls,
    legal: spec.legal,
    committedAt: spec.legal ? sentAt : null,
    statement: spec.statement,
    status: spec.status,
    rejectReason: spec.rejectReason ?? null,
    reviewNote: spec.reviewNote ?? null,
    reviewChecklist: approved
      ? {
          identityMatches: true,
          taxCodeVerified: true,
          storefrontMatches: true,
          phoneConfirmed: true,
        }
      : null,
    reviewedById: null,
    reviewedAt,
    createdAt: sentAt,
    updatedAt: reviewedAt ?? sentAt,
  });

  await connection.model('WorkspaceMember').create({
    workspaceId,
    pageUserId,
    userId: ownerId,
    role: WorkspaceMemberRole.OWNER,
  });

  for (const [index, proof] of spec.proofs.entries()) {
    const id = randomUUID();
    const key = `workspaces/${ownerId}/${id}.svg`;
    await storage.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: proofImage(proof, ownerName),
        ContentType: 'image/svg+xml',
      }),
    );
    await connection.model('WorkspaceProof').create({
      _id: id,
      ownerId,
      workspaceId,
      storageKey: key,
      kind: proof.kind,
      createdAt: new Date(sentAt.getTime() + index * 1000),
    });
  }
}

async function main(): Promise<void> {
  const url = required('DATABASE_URL');
  assertLocalDatabase(url);
  const password = required('SEED_USER_PASSWORD');
  const bucket =
    process.env.STORAGE_VERIFICATIONS_BUCKET || 'vedora-verifications';
  const storage = storageClient();
  const connection = await mongoose.createConnection(url).asPromise();
  registerModels(connection);
  try {
    await removePreviousRun(connection, storage, bucket);
    const passwordHash = await hash(password, 12);
    const ids = await createAccounts(connection, passwordHash);
    for (const spec of APPLICATIONS) {
      const ownerId = ids.get(spec.owner);
      const owner = ACCOUNTS.find(({ username }) => username === spec.owner);
      if (!ownerId || !owner) throw new Error(`Unknown owner ${spec.owner}`);
      await createApplication(
        connection,
        storage,
        bucket,
        spec,
        ownerId,
        owner.fullName,
      );
    }
    console.log(
      `Seeded ${ACCOUNTS.length} test accounts and ${APPLICATIONS.length} restaurant page applications.`,
    );
    console.log(
      'Sign in as test.chuquan.* or test.nguoimoi with SEED_USER_PASSWORD; see docs/test-data-restaurant-pages.md.',
    );
  } finally {
    await connection.close();
    storage.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error('Restaurant test data seed failed.', error);
  process.exitCode = 1;
});
