import type { IncomingMessage, ServerResponse } from 'node:http';
import { createGunzip } from 'node:zlib';
import type { ApiErrorBody } from '../../common/api-error.js';

/** Đường dẫn ingest; body của route này do `ingestBodyReader` đọc thay cho parser mặc định. */
export const INGEST_PATH = '/agent/v1/ingest';

/** Giới hạn body ingest: 10 MB, tính SAU khi giải nén (chống zip bomb). */
export const MAX_INGEST_BYTES = 10 * 1024 * 1024;

/** Lỗi khi đọc body: middleware chạy trước Nest nên tự trả `{ error, message }`. */
export class IngestBodyError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
  }
}

const tooLarge = () =>
  new IngestBodyError(413, {
    error: 'payload_too_large',
    message: 'Batch vượt quá 10 MB, hãy chia nhỏ rồi gửi lại.',
  });

const invalid = (message: string) =>
  new IngestBodyError(400, { error: 'validation_error', message });

/**
 * Đọc toàn bộ body (giải nén gzip nếu có) với giới hạn `maxBytes` trên dữ liệu ĐÃ giải nén.
 * Vượt giới hạn thì dừng ngay, không gom thêm vào bộ nhớ.
 */
export function readIngestBody(
  req: IncomingMessage,
  maxBytes = MAX_INGEST_BYTES,
): Promise<Buffer> {
  const encoding = (req.headers['content-encoding'] ?? '').trim().toLowerCase();
  if (encoding !== '' && encoding !== 'identity' && encoding !== 'gzip') {
    return Promise.reject(
      new IngestBodyError(415, {
        error: 'unsupported_media_type',
        message: `Không hỗ trợ Content-Encoding "${encoding}", chỉ nhận gzip hoặc không nén.`,
      }),
    );
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return Promise.reject(tooLarge());
  }

  return new Promise((resolve, reject) => {
    const gunzip = encoding === 'gzip' ? createGunzip() : null;
    const source = gunzip ?? req;
    const chunks: Buffer[] = [];
    let rawBytes = 0;
    let total = 0;
    let settled = false;

    const fail = (error: IngestBodyError) => {
      if (settled) return;
      settled = true;
      if (gunzip) {
        req.unpipe(gunzip);
        gunzip.destroy();
      }
      // Bỏ phần body còn lại; response 413 gửi kèm `Connection: close`.
      req.resume();
      reject(error);
    };

    source.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    source.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    source.on('error', () => {
      fail(
        gunzip
          ? invalid('Body gzip bị hỏng, không giải nén được.')
          : invalid('Không đọc được body.'),
      );
    });
    if (gunzip) {
      // Dữ liệu nén cũng không được vượt giới hạn.
      req.on('data', (chunk: Buffer) => {
        rawBytes += chunk.length;
        if (rawBytes > maxBytes) fail(tooLarge());
      });
      req.on('error', () => fail(invalid('Không đọc được body.')));
      req.pipe(gunzip);
    }
  });
}

/** Parse JSON từ body đã đọc. */
export function parseIngestJson(buffer: Buffer): unknown {
  try {
    return JSON.parse(buffer.toString('utf8')) as unknown;
  } catch {
    throw invalid('Body không phải JSON hợp lệ.');
  }
}

type Next = (error?: unknown) => void;

/**
 * Middleware đọc body của `POST /agent/v1/ingest`: tối đa 10 MB sau giải nén, hỗ trợ
 * `Content-Encoding: gzip`. `setupApp` đăng ký nó TRƯỚC parser JSON mặc định của Nest
 * (100 KB); body đã đọc xong nên parser mặc định bỏ qua request này.
 *
 * Tên hàm phải khác `jsonParser`: Nest dựa vào tên đó để quyết định có đăng ký parser
 * mặc định (cho mọi route khác) hay không.
 */
export function ingestBodyReader(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
  next: Next,
): void {
  if (req.method !== 'POST') {
    next();
    return;
  }
  readIngestBody(req)
    .then((buffer) => {
      req.body = parseIngestJson(buffer);
      next();
    })
    .catch((error: unknown) => {
      if (!(error instanceof IngestBodyError)) {
        next(error);
        return;
      }
      res.statusCode = error.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (error.status === 413) res.setHeader('Connection', 'close');
      res.end(JSON.stringify(error.body));
    });
}
