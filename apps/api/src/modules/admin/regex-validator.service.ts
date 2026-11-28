import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '../../common/api-error.js';

export interface RegexInput {
  id: string;
  regex: string;
}

export type RegexCheck =
  | { ok: true; matches: number; redacted: string | null }
  | { ok: false; index: number; id: string; error: string };

const TIMEOUT_MS = 5_000;

/** Đường dẫn helper Rust; ghi đè bằng `REGEX_VALIDATOR_BIN` (vd. trong image Docker). */
export function regexValidatorPath(): string {
  const fromEnv = process.env.REGEX_VALIDATOR_BIN;
  if (fromEnv) return fromEnv;
  const exe =
    process.platform === 'win32' ? 'regex-validator.exe' : 'regex-validator';
  return join(
    process.cwd(),
    'tools',
    'regex-validator',
    'target',
    'release',
    exe,
  );
}

/**
 * Kiểm tra pattern redaction bằng đúng crate `regex` và `size_limit` của CLI (helper Rust ở
 * `tools/regex-validator`). Không dùng `RegExp` của Node vì cú pháp khác (lookaround, backreference).
 * Không log regex hay đoạn mẫu.
 */
@Injectable()
export class RegexValidatorService {
  check(patterns: RegexInput[], sample?: string): Promise<RegexCheck> {
    const bin = regexValidatorPath();
    if (!existsSync(bin)) {
      throw new ApiError(
        503,
        'regex_validator_unavailable',
        'Chưa có helper kiểm tra regex. Chạy `pnpm --filter @teamlens/api build:regex-validator`.',
      );
    }
    return new Promise((resolve, reject) => {
      const child = spawn(bin, [], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
      let out = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new ApiError(
            503,
            'regex_validator_unavailable',
            'Helper kiểm tra regex chạy quá thời gian.',
          ),
        );
      }, TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.on('error', () => {
        clearTimeout(timer);
        reject(
          new ApiError(
            503,
            'regex_validator_unavailable',
            'Không chạy được helper kiểm tra regex.',
          ),
        );
      });
      child.on('close', () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(out) as RegexCheck);
        } catch {
          reject(
            new ApiError(
              503,
              'regex_validator_unavailable',
              'Helper kiểm tra regex trả kết quả không hợp lệ.',
            ),
          );
        }
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(JSON.stringify({ patterns, sample }));
    });
  }
}
