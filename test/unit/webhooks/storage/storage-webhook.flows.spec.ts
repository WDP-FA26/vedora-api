import { ConfigService } from '@nestjs/config';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { InvalidInputException } from '@src/common/exceptions/invalid-input.exception.js';
import { UnauthenticatedException } from '@src/common/exceptions/unauthenticated.exception.js';
import {
  StorageService,
  StorageTarget,
  type StorageEvent,
} from '@src/storage/storage.service.js';
import { StorageWebhookGuard } from '@src/webhooks/storage/storage-webhook.guard.js';

const TOKEN = 'storage-webhook-flow-token';

function realStorage(): StorageService {
  return new StorageService(
    new ConfigService({
      STORAGE_ENDPOINT: 'http://127.0.0.1:1',
      STORAGE_PUBLIC_URL: 'http://127.0.0.1:1',
      STORAGE_ACCESS_KEY: 'access',
      STORAGE_SECRET_KEY: 'secret',
      STORAGE_REGION: 'us-east-1',
      STORAGE_WEBHOOK_TOKEN: TOKEN,
      STORAGE_KNOWLEDGE_BUCKET: 'vedora-knowledge',
      STORAGE_PROFILES_BUCKET: 'vedora-profiles',
      STORAGE_VERIFICATIONS_BUCKET: 'vedora-verifications',
      STORAGE_SUPPORT_BUCKET: 'vedora-support',
      STORAGE_BLOGS_BUCKET: 'vedora-blogs',
    }),
  );
}

function record(
  bucket: string,
  key: string,
  eventName = 's3:ObjectCreated:Put',
) {
  return { eventName, s3: { bucket: { name: bucket }, object: { key } } };
}

describe('Storage webhook flows (contract matrix)', () => {
  const storage = realStorage();

  describe('guard', () => {
    const guard = new StorageWebhookGuard(storage);
    const contextWith = (authorization?: string) =>
      new ExecutionContextHost([
        {
          headers: { authorization },
          path: '/api/v1/webhooks/storage/profiles',
        },
      ]);

    it('accepts the configured bearer token', () => {
      expect(guard.canActivate(contextWith(`Bearer ${TOKEN}`))).toBe(true);
    });

    it('rejects the token followed by trailing whitespace', () => {
      expect(() => guard.canActivate(contextWith(`Bearer ${TOKEN} `))).toThrow(
        UnauthenticatedException,
      );
    });

    it('rejects a token of the same length that differs in the last character', () => {
      const forged = `${TOKEN.slice(0, -1)}X`;

      expect(() => guard.canActivate(contextWith(`Bearer ${forged}`))).toThrow(
        UnauthenticatedException,
      );
    });

    it('rejects an empty bearer value', () => {
      expect(() => guard.canActivate(contextWith('Bearer '))).toThrow(
        UnauthenticatedException,
      );
    });
  });

  describe('event parsing', () => {
    it('ignores an object created in another target bucket so profiles cannot mark knowledge files', () => {
      const keys = storage.parseEvent(StorageTarget.Profiles, {
        Records: [record('vedora-knowledge', 'knowledge/doc.pdf')],
      });

      expect(keys).toEqual([]);
    });

    it('ignores removal events', () => {
      const keys = storage.parseEvent(StorageTarget.Profiles, {
        Records: [
          record('vedora-profiles', 'u/a.webp', 's3:ObjectRemoved:Delete'),
        ],
      });

      expect(keys).toEqual([]);
    });

    it('decodes URL-encoded keys including + as space', () => {
      const keys = storage.parseEvent(StorageTarget.Profiles, {
        Records: [record('vedora-profiles', 'u%2Fmy+photo%C3%A1.webp')],
      });

      expect(keys).toEqual(['u/my photoá.webp']);
    });

    it('rejects a body without Records as BAD_REQUEST', () => {
      expect(() => storage.parseEvent(StorageTarget.Profiles, {})).toThrow(
        InvalidInputException,
      );
    });

    // BUG-2: malformed authenticated S3 events crash with a 500 instead of a 400
    it('reports a key with broken percent-encoding as invalid input, not an unexpected error', () => {
      const body: StorageEvent = {
        Records: [record('vedora-profiles', 'u/%E0%A4%A.webp')],
      };

      expect(() => storage.parseEvent(StorageTarget.Profiles, body)).toThrow(
        InvalidInputException,
      );
    });

    // BUG-2: malformed authenticated S3 events crash with a 500 instead of a 400
    it('reports a null record as invalid input, not an unexpected error', () => {
      const body = JSON.parse('{"Records":[null]}') as StorageEvent;

      expect(() => storage.parseEvent(StorageTarget.Profiles, body)).toThrow(
        InvalidInputException,
      );
    });
  });
});
