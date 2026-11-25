import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PgBoss, type SendOptions, type WorkHandler } from 'pg-boss';
import type { Env } from '../config/env.js';
import { JOBS, type JobName, type JobPayloads } from './jobs.js';

export const PGBOSS_SCHEMA = 'pgboss';

/** Bọc pg-boss: chạy trên chính Postgres của app, schema `pgboss`. */
@Injectable()
export class QueueService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  readonly boss: PgBoss;

  constructor(config: ConfigService<Env, true>) {
    this.boss = new PgBoss({
      connectionString: config.get('DATABASE_URL', { infer: true }),
      schema: PGBOSS_SCHEMA,
      max: 4,
    });
    this.boss.on('error', (error: unknown) => {
      this.logger.error(
        `Lỗi pg-boss: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async onModuleInit(): Promise<void> {
    await this.boss.start();
    for (const name of Object.values(JOBS)) {
      await this.boss.createQueue(name);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 5000 });
  }

  /** Đẩy một job vào hàng đợi. Truyền `options.db` để enqueue cùng transaction. */
  send<N extends JobName>(
    name: N,
    payload: JobPayloads[N],
    options?: SendOptions,
  ): Promise<string | null> {
    return this.boss.send(name, payload, options);
  }

  /** Đăng ký worker xử lý job. */
  work<N extends JobName>(
    name: N,
    handler: WorkHandler<JobPayloads[N]>,
  ): Promise<string> {
    return this.boss.work<JobPayloads[N]>(name, handler);
  }
}
