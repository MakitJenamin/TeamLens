import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { JOBS } from '../../queue/jobs.js';
import { QueueService } from '../../queue/queue.service.js';
import { runRetention } from './retention.service.js';

/** 02:15 UTC (09:15 giờ Việt Nam), lúc ít người dùng. */
export const RETENTION_CRON = '15 2 * * *';

/** Đăng ký lịch chạy hằng đêm và worker của job `retention.nightly` (M5.5). */
@Injectable()
export class RetentionWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger(RetentionWorker.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(QueueService) private readonly queue: QueueService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // `TEAMLENS_RETENTION_JOB=off` (e2e đặt sẵn): gỡ lịch và không nhận job.
    if (process.env.TEAMLENS_RETENTION_JOB === 'off') {
      await this.queue.boss.unschedule(JOBS.retentionNightly);
      return;
    }
    // Lịch nằm trong DB của pg-boss nên nhiều instance API vẫn chỉ ra một job mỗi đêm.
    // `missed: 'once'`: server tắt đúng giờ chạy thì chạy bù một lần khi bật lại.
    await this.queue.boss.schedule(JOBS.retentionNightly, RETENTION_CRON, {}, {
      tz: 'UTC',
      missed: 'once',
    });
    await this.queue.work(JOBS.retentionNightly, async () => {
      const run = await runRetention(this.db);
      this.logger.log(
        `Retention: ${run.retentionDays ?? 'vô hạn'} ngày, drop ${run.droppedPartitions.length} partition, xóa ${run.deletedTurns} turn, ${run.deletedAiResults} kết quả AI, ${run.deletedNotes} ghi chú, ${run.deletedPromptLibrary} mục thư viện`,
      );
    });
  }
}
