import 'dotenv/config';
import mongoose from 'mongoose';

interface Cleanup {
  collection: string;
  fields: string[];
}

const CLEANUPS: Cleanup[] = [
  {
    collection: 'posts',
    fields: [
      'moderation.violationScore',
      'moderation.scores',
      'moderation.route',
      'moderation.heldAt',
      'moderation.evidence.decision',
      'moderation.evidence.category',
    ],
  },
  {
    collection: 'moderation_settings',
    fields: [
      'rejectThreshold',
      'reviewThreshold',
      'manipulationThreshold',
      'manipulationEnforced',
    ],
  },
  {
    collection: 'support_tickets',
    fields: [
      'appeal.postSnapshot.routeRule',
      'appeal.postSnapshot.routeAppliedBy',
      'appeal.postSnapshot.routeCategory',
    ],
  },
];

interface ElementCleanup {
  collection: string;
  field: string;
  unset: string;
}

const ELEMENT_CLEANUPS: ElementCleanup[] = [
  {
    collection: 'posts',
    field: 'moderation.evidence.items.box',
    unset: 'moderation.evidence.items.$[].box',
  },
];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

function anyOf(fields: string[]) {
  return { $or: fields.map((field) => ({ [field]: { $exists: true } })) };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const connection = await mongoose
    .createConnection(required('DATABASE_URL'))
    .asPromise();
  try {
    for (const { collection, fields } of CLEANUPS) {
      const documents = connection.collection(collection);
      for (const field of fields) {
        const count = await documents.countDocuments({
          [field]: { $exists: true },
        });
        console.log(`${collection}.${field}: ${count}`);
      }
      const unset: Record<string, ''> = {};
      for (const field of fields) unset[field] = '';
      if (!apply) {
        const count = await documents.countDocuments(anyOf(fields));
        console.log(`${collection}: ${count} documents would change.`);
        continue;
      }
      const result = await documents.updateMany(anyOf(fields), {
        $unset: unset,
      });
      console.log(`${collection}: ${result.modifiedCount} documents updated.`);
    }
    for (const { collection, field, unset } of ELEMENT_CLEANUPS) {
      const documents = connection.collection(collection);
      const filter = { [field]: { $exists: true } };
      if (!apply) {
        const count = await documents.countDocuments(filter);
        console.log(`${collection}.${field}: ${count} documents would change.`);
        continue;
      }
      const result = await documents.updateMany(filter, {
        $unset: { [unset]: '' },
      });
      console.log(
        `${collection}.${field}: ${result.modifiedCount} documents updated.`,
      );
    }
    if (!apply) console.log('Dry run; pass --apply to remove the fields.');
  } finally {
    await connection.close();
  }
}

void main().catch((error: unknown) => {
  console.error('Cleaning legacy moderation fields failed.', error);
  process.exitCode = 1;
});
