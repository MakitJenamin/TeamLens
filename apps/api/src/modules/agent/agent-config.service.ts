import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AgentConfig } from '@teamlens/schema';
import { asc, eq, inArray } from 'drizzle-orm';
import type { AuthUser } from '../../common/auth-context.js';
import type { Env } from '../../config/env.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import {
  projectMembers,
  projectRepos,
  settings,
} from '../../db/schema/index.js';
import { ConsentTextService } from '../consent/consent-text.service.js';
import {
  mergeTruncation,
  parseRedactionPatterns,
  SETTINGS_KEYS,
} from './agent-config.js';

/** Dựng `GET /agent/v1/config` cho thiết bị của user (SPEC 6.2, 6.3, 7.2). */
@Injectable()
export class AgentConfigService {
  private readonly minCliVersion: string;

  constructor(
    @Inject(DB) private readonly db: Database,
    config: ConfigService<Env, true>,
    @Inject(ConsentTextService)
    private readonly consentText: ConsentTextService,
  ) {
    this.minCliVersion = config.get('MIN_CLI_VERSION', { infer: true });
  }

  async getConfig(user: AuthUser): Promise<AgentConfig> {
    // Repo pattern của mọi project user là thành viên (giống `whoami`).
    const repoRows = await this.db
      .select({
        projectId: projectRepos.projectId,
        pattern: projectRepos.remotePattern,
      })
      .from(projectRepos)
      .innerJoin(
        projectMembers,
        eq(projectMembers.projectId, projectRepos.projectId),
      )
      .where(eq(projectMembers.userId, user.id))
      .orderBy(asc(projectRepos.remotePattern), asc(projectRepos.projectId));

    const settingRows = await this.db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(
        inArray(settings.key, [
          SETTINGS_KEYS.redactionPatterns,
          SETTINGS_KEYS.truncation,
        ]),
      );
    const setting = (key: string): unknown =>
      settingRows.find((row) => row.key === key)?.value;

    return {
      repo_patterns: repoRows.map((row) => ({
        project_id: row.projectId,
        pattern: row.pattern,
      })),
      redaction_patterns: parseRedactionPatterns(
        setting(SETTINGS_KEYS.redactionPatterns),
      ),
      truncation: mergeTruncation(setting(SETTINGS_KEYS.truncation)),
      consent_text_version: (await this.consentText.get()).version,
      min_cli_version: this.minCliVersion,
    };
  }
}
