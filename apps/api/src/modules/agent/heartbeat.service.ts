import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { HeartbeatResult } from '@teamlens/schema';
import { eq, sql } from 'drizzle-orm';
import { ApiError } from '../../common/api-error.js';
import type { AuthDevice } from '../../common/auth-context.js';
import type { Env } from '../../config/env.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { devices, type DeviceStatus } from '../../db/schema/index.js';
import { CONSENT_TEXT_VERSION } from '../consent/consent-text.js';
import type { HeartbeatBody } from './heartbeat.js';

/** Ghi heartbeat của thiết bị vào `devices` (SPEC 4.1, 7.2). */
@Injectable()
export class HeartbeatService {
  private readonly minCliVersion: string;

  constructor(
    @Inject(DB) private readonly db: Database,
    config: ConfigService<Env, true>,
  ) {
    this.minCliVersion = config.get('MIN_CLI_VERSION', { infer: true });
  }

  async record(
    device: AuthDevice,
    body: HeartbeatBody,
  ): Promise<HeartbeatResult> {
    // `consent_revoked` do module consent (M3.7) quản lý: heartbeat không ghi đè.
    const [row] = await this.db
      .update(devices)
      .set({
        lastSeenAt: sql`now()`,
        cliVersion: body.cli_version,
        status: sql<DeviceStatus>`CASE WHEN ${devices.status} = 'consent_revoked' THEN ${devices.status} ELSE ${body.status} END`,
        lastHeartbeat: {
          agents: body.agents,
          parse_errors: body.parse_errors,
          queue: body.queue,
          sent_at: body.sent_at,
        },
      })
      .where(eq(devices.id, device.id))
      .returning({ status: devices.status });
    if (!row) {
      throw new ApiError(401, 'invalid_token', 'Thiết bị không còn tồn tại.');
    }
    return {
      status:
        row.status === 'consent_revoked' ? 'consent_revoked' : body.status,
      consent_text_version: CONSENT_TEXT_VERSION,
      min_cli_version: this.minCliVersion,
    };
  }
}
