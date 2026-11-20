import { EventEmitter } from 'node:events';
import * as dns from 'node:dns/promises';
import * as childProcess from 'node:child_process';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  type ArgumentsHost,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { IsInt, IsString, ValidateNested, validate } from 'class-validator';
import { Type } from 'class-transformer';
import {
  AppExceptionFilter,
  toErrorBody,
} from '../../../src/common/exceptions/app-exception.filter.js';
import { ExternalServiceException } from '../../../src/common/exceptions/external-service.exception.js';
import { InvalidInputException } from '../../../src/common/exceptions/invalid-input.exception.js';
import { errorResponses } from '../../../src/common/exceptions/swagger-error-responses.js';
import { FfmpegError, runFfmpeg } from '../../../src/common/ffmpeg/ffmpeg.js';
import {
  fetchPublicImage,
  UnsafeImageUrlError,
} from '../../../src/common/http/fetch-public-image.js';
import { ApiPaginatedResponse } from '../../../src/common/pagination/api-paginated-response.decorator.js';
import { PaginationLimitDto } from '../../../src/common/pagination/pagination-limit.dto.js';
import { PaginationQueryDto } from '../../../src/common/pagination/pagination-query.dto.js';
import {
  escapeRegExp,
  extractMarkdownMediaUrls,
} from '../../../src/common/text.js';
import {
  parsePayload,
  validatePayload,
} from '../../../src/common/validation.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

class ChildPayload {
  @IsInt()
  count!: number;
}

class ParentPayload {
  @IsString()
  name!: string;

  @ValidateNested()
  @Type(() => ChildPayload)
  child!: ChildPayload;
}

class DummyItemDto {
  id!: string;
}

describe('common utilities & infrastructure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.FFMPEG_PATH;
  });

  describe('escapeRegExp', () => {
    it('escapes all special regex metacharacters', () => {
      expect(escapeRegExp('a.b*c+?^${}()|[]\\')).toBe(
        'a\\.b\\*c\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\',
      );
      expect(escapeRegExp('đậu hũ')).toBe('đậu hũ');
    });
  });

  describe('AppExceptionFilter & errorResponses', () => {
    it('maps AppException, framework HttpException, and unknown errors consistently', () => {
      expect(
        toErrorBody(
          new InvalidInputException('EMPTY_POST', 'Empty post', {
            field: 'body',
          }),
        ),
      ).toEqual({
        statusCode: 400,
        code: 'EMPTY_POST',
        message: 'Empty post',
        details: { field: 'body' },
      });

      expect(toErrorBody(new BadRequestException('bad'))).toEqual({
        statusCode: 400,
        code: 'BAD_REQUEST',
        message: 'bad',
      });

      expect(toErrorBody(new ConflictException('dup'))).toEqual({
        statusCode: 409,
        code: 'CONFLICT',
        message: 'dup',
      });

      expect(toErrorBody(new InternalServerErrorException('boom'))).toEqual({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'boom',
      });

      expect(toErrorBody(new HttpException('teapot', 418))).toEqual({
        statusCode: 418,
        code: 'BAD_REQUEST',
        message: 'teapot',
      });

      expect(toErrorBody(new Error('unexpected'))).toEqual({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
    });

    it('writes response JSON and logs 5xx errors without writing after headersSent', () => {
      const filter = new AppExceptionFilter();
      const json = vi.fn();
      const status = vi.fn(() => ({ json }));
      const response = { headersSent: false, status };
      const host = {
        switchToHttp: () => ({
          getResponse: () => response,
        }),
      } as unknown as ArgumentsHost;

      filter.catch(new ExternalServiceException('qdrant', 'timeout'), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.BAD_GATEWAY);
      expect(json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'EXTERNAL_SERVICE_FAILED',
          statusCode: 502,
        }),
      );

      filter.catch(new Error('raw error'), host);
      filter.catch('string failure', host);
      expect(status).toHaveBeenCalledWith(500);

      json.mockClear();
      status.mockClear();
      response.headersSent = true;
      filter.catch(new BadRequestException('late'), host);
      expect(status).not.toHaveBeenCalled();
      expect(json).not.toHaveBeenCalled();
    });

    it('declares standard Swagger error responses', () => {
      const responses = errorResponses();
      expect(responses.map((r) => r.status)).toEqual([
        400, 401, 403, 404, 409, 429, 500, 502, 503,
      ]);
    });
  });

  describe('validation helpers', () => {
    it('validates objects, nested errors, and rejects non-objects', () => {
      expect(validatePayload(ParentPayload, null)).toEqual({
        value: null,
        errors: ['payload must be an object'],
      });
      expect(validatePayload(ParentPayload, [])).toEqual({
        value: null,
        errors: ['payload must be an object'],
      });

      const invalid = validatePayload(ParentPayload, {
        name: 123,
        child: { count: 'nope' },
      });
      expect(invalid.value).toBeNull();
      expect(invalid.errors.some((e) => e.startsWith('name:'))).toBe(true);
      expect(invalid.errors.some((e) => e.startsWith('child.count:'))).toBe(
        true,
      );

      const valid = parsePayload('openrouter', ParentPayload, {
        name: 'ok',
        child: { count: 2 },
      });
      expect(valid).toEqual({ name: 'ok', child: { count: 2 } });

      expect(() =>
        parsePayload('cloudinary', ParentPayload, { name: 1 }),
      ).toThrow(ExternalServiceException);
    });
  });

  describe('pagination DTOs and decorator', () => {
    it('transforms string query params to integers and validates bounds', async () => {
      const valid = plainToInstance(PaginationQueryDto, {
        page: '2',
        limit: '50',
      });
      expect(valid.page).toBe(2);
      expect(valid.limit).toBe(50);
      await expect(validate(valid)).resolves.toHaveLength(0);

      const invalid = plainToInstance(PaginationQueryDto, {
        page: '0',
        limit: '51',
      });
      const errors = await validate(invalid);
      expect(errors.length).toBe(2);

      const limitOnly = plainToInstance(PaginationLimitDto, {});
      expect(limitOnly.limit).toBe(20);
      await expect(validate(limitOnly)).resolves.toHaveLength(0);
    });

    it('applies ApiPaginatedResponse decorator without errors', () => {
      class SampleController {
        @ApiPaginatedResponse(DummyItemDto)
        list(): void {}
      }
      expect(typeof SampleController.prototype.list).toBe('function');
    });
  });

  describe('fetchPublicImage', () => {
    it('rejects malformed URLs, non-https schemes, and private IPv4/IPv6 addresses', async () => {
      await expect(fetchPublicImage('not a url')).rejects.toBeInstanceOf(
        UnsafeImageUrlError,
      );
      await expect(
        fetchPublicImage('http://example.com/a.jpg'),
      ).rejects.toBeInstanceOf(UnsafeImageUrlError);

      for (const ip of [
        '127.0.0.1',
        '10.0.0.1',
        '172.16.0.1',
        '192.168.1.1',
        '169.254.1.1',
        '100.64.0.1',
        '0.0.0.0',
        '224.0.0.1',
        '[::1]',
        '[::]',
        '[fc00::1]',
        '[fd00::1]',
        '[fe80::1]',
      ]) {
        await expect(
          fetchPublicImage(`https://${ip}/img.png`),
        ).rejects.toBeInstanceOf(UnsafeImageUrlError);
      }
    });

    it('rejects IPv4-mapped and NAT64 IPv6 private addresses', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
      );
      for (const ip of [
        '[::ffff:127.0.0.1]',
        '[0:0:0:0:0:ffff:7f00:1]',
        '[::ffff:10.0.0.1]',
        '[::ffff:169.254.169.254]',
        '[::ffff:192.168.1.1]',
        '[::127.0.0.1]',
        '[64:ff9b::127.0.0.1]',
        '[ff02::1]',
      ]) {
        await expect(
          fetchPublicImage(`https://${ip}/img.png`),
        ).rejects.toBeInstanceOf(UnsafeImageUrlError);
      }
    });

    it('rejects hostnames that resolve to empty or private DNS addresses', async () => {
      vi.mocked(dns.lookup).mockResolvedValueOnce([]);
      await expect(
        fetchPublicImage('https://empty.example.com/a.png'),
      ).rejects.toBeInstanceOf(UnsafeImageUrlError);

      vi.mocked(dns.lookup).mockResolvedValueOnce([
        { address: '10.0.0.5', family: 4 },
      ]);
      await expect(
        fetchPublicImage('https://internal.example.com/a.png'),
      ).rejects.toBeInstanceOf(UnsafeImageUrlError);
    });

    it('handles 4xx, 5xx, oversized content-length, oversized body, and valid images', async () => {
      vi.mocked(dns.lookup).mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
      ]);

      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
      await expect(
        fetchPublicImage('https://example.com/missing.png'),
      ).resolves.toBeNull();

      fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
      await expect(
        fetchPublicImage('https://example.com/down.png'),
      ).rejects.toThrow('Image fetch answered 503');

      fetchMock.mockResolvedValueOnce(
        new Response(new Uint8Array(4), {
          status: 200,
          headers: { 'content-length': String(10 * 1024 * 1024 + 1) },
        }),
      );
      await expect(
        fetchPublicImage('https://example.com/huge-header.png'),
      ).rejects.toBeInstanceOf(UnsafeImageUrlError);

      fetchMock.mockResolvedValueOnce(
        new Response(new Uint8Array(10 * 1024 * 1024 + 1), { status: 200 }),
      );
      await expect(
        fetchPublicImage('https://example.com/huge-body.png'),
      ).rejects.toBeInstanceOf(UnsafeImageUrlError);

      const bytes = Uint8Array.from([1, 2, 3, 4]);
      fetchMock.mockResolvedValueOnce(new Response(bytes, { status: 200 }));
      const result = await fetchPublicImage('https://example.com/ok.png');
      expect(result).toEqual(Buffer.from(bytes));
    });

    it('extracts inline and reference markdown media URLs while skipping fenced code', () => {
      const md = [
        '![inline](https://storage.vedora.vn/vedora-blogs/a.png)',
        '![wrapped](<https://storage.vedora.vn/vedora-blogs/b.png> "title")',
        '![ref][pic]',
        '[regular link](https://example.com)',
        '```md',
        '![ignored](https://evil.example/code.png)',
        '```',
        '[pic]: https://storage.vedora.vn/vedora-blogs/c.png',
      ].join('\n');
      expect(extractMarkdownMediaUrls(md)).toEqual([
        'https://storage.vedora.vn/vedora-blogs/a.png',
        'https://storage.vedora.vn/vedora-blogs/b.png',
        'https://storage.vedora.vn/vedora-blogs/c.png',
      ]);
    });
  });

  describe('runFfmpeg', () => {
    function makeFakeChild() {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
      return child;
    }

    it('resolves stdout/stderr on exit code 0 and respects FFMPEG_PATH', async () => {
      process.env.FFMPEG_PATH = '/usr/local/bin/ffmpeg-custom';
      const child = makeFakeChild();
      vi.mocked(childProcess.spawn).mockReturnValueOnce(child as never);

      const promise = runFfmpeg(['-version'], Buffer.from('in'), 5000);
      child.stdout.emit('data', Buffer.from('out'));
      child.stderr.emit('data', Buffer.from('warn'));
      child.emit('close', 0, null);

      await expect(promise).resolves.toEqual({
        stdout: Buffer.from('out'),
        stderr: 'warn',
      });
      expect(childProcess.spawn).toHaveBeenCalledWith(
        '/usr/local/bin/ffmpeg-custom',
        ['-hide_banner', '-version'],
        { stdio: 'pipe', timeout: 5000 },
      );
    });

    it('rejects with FfmpegError on non-zero exit or signal, and propagates spawn error', async () => {
      const failedChild = makeFakeChild();
      vi.mocked(childProcess.spawn).mockReturnValueOnce(failedChild as never);
      const p1 = runFfmpeg(['-i', 'bad']);
      failedChild.stderr.emit('data', Buffer.from('line1\nline2\nfatal'));
      failedChild.emit('close', 1, null);
      await expect(p1).rejects.toBeInstanceOf(FfmpegError);

      const signaledChild = makeFakeChild();
      vi.mocked(childProcess.spawn).mockReturnValueOnce(signaledChild as never);
      const p2 = runFfmpeg(['-i', 'timeout']);
      signaledChild.emit('close', null, 'SIGTERM');
      await expect(p2).rejects.toThrow('ffmpeg exited with SIGTERM');

      const erroredChild = makeFakeChild();
      vi.mocked(childProcess.spawn).mockReturnValueOnce(erroredChild as never);
      const p3 = runFfmpeg(['-i', 'missing']);
      erroredChild.emit('error', new Error('ENOENT'));
      await expect(p3).rejects.toThrow('ENOENT');
    });
  });
});
