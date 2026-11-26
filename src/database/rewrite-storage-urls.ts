/**
 * One-off migration: rewrite stored public object-storage URLs across MongoDB
 * collections from the legacy RustFS domain to the new SeaweedFS domain.
 *
 *   npm run rewrite:storage-urls                                      # dry run
 *   npm run rewrite:storage-urls -- --apply                           # write changes
 *   npm run rewrite:storage-urls -- --from=https://old --to=https://new
 *
 * Scans every collection in the database (including nested objects and arrays)
 * so no stored storage URL is missed.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

interface RewriteResult {
  value: unknown;
  changes: string[];
}

function parseFlag(prefix: string, fallback: string): string {
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  const value = match ? match.slice(prefix.length) : fallback;
  return value.replace(/\/+$/, '');
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rewriteValue(
  value: unknown,
  fromPrefix: string,
  toPrefix: string,
  path: string,
): RewriteResult {
  if (typeof value === 'string') {
    if (!value.includes(fromPrefix)) {
      return { value, changes: [] };
    }
    return {
      value: value.split(fromPrefix).join(toPrefix),
      changes: [path],
    };
  }
  if (Array.isArray(value)) {
    let dirty = false;
    const changes: string[] = [];
    const next = value.map((item: unknown, index: number) => {
      const result = rewriteValue(item, fromPrefix, toPrefix, `${path}[${index}]`);
      if (result.changes.length > 0) {
        dirty = true;
        changes.push(...result.changes);
      }
      return result.value;
    });
    return { value: dirty ? next : value, changes };
  }
  if (isPlainObject(value)) {
    let dirty = false;
    const changes: string[] = [];
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      const result = rewriteValue(entry, fromPrefix, toPrefix, childPath);
      if (result.changes.length > 0) {
        dirty = true;
        changes.push(...result.changes);
      }
      next[key] = result.value;
    }
    return { value: dirty ? next : value, changes };
  }
  return { value, changes: [] };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const fromPrefix = parseFlag('--from=', 'https://s3-vedora.quanphung.dev');
  const toPrefix = parseFlag('--to=', 'https://blob.quanphung.dev');

  if (!fromPrefix || !toPrefix || fromPrefix === toPrefix) {
    throw new Error('Provide distinct non-empty --from and --to prefixes.');
  }

  console.log(
    `Mode: ${apply ? 'APPLY' : 'DRY RUN'} (${fromPrefix} -> ${toPrefix})`,
  );

  const connection = await mongoose
    .createConnection(requiredEnv('DATABASE_URL'))
    .asPromise();

  try {
    const db = connection.db;
    if (!db) throw new Error('MongoDB handle is unavailable.');

    const collections = await db.listCollections().toArray();
    let totalMatchedDocs = 0;
    let totalUpdatedDocs = 0;

    for (const { name } of collections) {
      if (name.startsWith('system.')) continue;
      const collection = db.collection<Record<string, unknown>>(name);
      const cursor = collection.find({});
      let matchedInCollection = 0;
      const fieldCounts = new Map<string, number>();

      for await (const doc of cursor) {
        const result = rewriteValue(doc, fromPrefix, toPrefix, '');
        if (result.changes.length === 0) continue;

        matchedInCollection++;
        totalMatchedDocs++;
        for (const field of result.changes) {
          const normalized = field.replace(/\[\d+\]/g, '[]');
          fieldCounts.set(normalized, (fieldCounts.get(normalized) ?? 0) + 1);
        }

        if (apply && isPlainObject(result.value)) {
          await collection.replaceOne({ _id: doc._id }, result.value);
          totalUpdatedDocs++;
        }
      }

      if (matchedInCollection > 0) {
        const summary = [...fieldCounts.entries()]
          .map(([field, count]) => `${field}=${count}`)
          .join(', ');
        console.log(`  ${name}: ${matchedInCollection} doc(s) (${summary})`);
      }
    }

    console.log(
      `Done. ${totalMatchedDocs} document(s) matched; ${apply ? `${totalUpdatedDocs} updated.` : 'dry run only (pass --apply to write).'}`,
    );
  } finally {
    await connection.close();
  }
}

void main().catch((error: unknown) => {
  console.error('Rewriting storage URLs failed.', error);
  process.exitCode = 1;
});
