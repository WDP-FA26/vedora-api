/**
 * One-off cleanup after the single-pass Claude Haiku moderation rewrite:
 * removes fields the old two-stage pipeline stored and the code no longer
 * reads (scores, router, hold markers, thresholds). Nothing breaks without it;
 * Mongoose ignores unknown fields.
 *
 *   npm run clean:legacy-moderation            # dry run: counts what would change
 *   npm run clean:legacy-moderation -- --apply # removes the fields
 *
 * Only these fields are removed; status, verdicts, risk levels, evidence
 * items and `updatedAt` are left alone.
 */
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
    if (!apply) console.log('Dry run; pass --apply to remove the fields.');
  } finally {
    await connection.close();
  }
}

void main().catch((error: unknown) => {
  console.error('Cleaning legacy moderation fields failed.', error);
  process.exitCode = 1;
});
