import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { JOBS } from '../../queue/jobs.js';
import { QueueService } from '../../queue/queue.service.js';
import {
  installDefaultRules,
  scoreSession,
} from './score-session.js';
import { RescoreService } from './rescore.service.js';

@Injectable()
export class RulesWorker implements OnApplicationBootstrap {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(RescoreService) private readonly rescore: RescoreService,
  ) {}

  async onApplicationBootstrap() {
    await installDefaultRules(this.db);
    await this.queue.work(JOBS.sessionIngested, async (jobs) => {
      for (const job of jobs) await scoreSession(this.db, job.data.sessionId);
    });
    await this.queue.work(JOBS.projectRescore, async (jobs) => {
      for (const job of jobs) await this.rescore.execute(job.data.projectId, job.data.runId);
    });
  }
}
