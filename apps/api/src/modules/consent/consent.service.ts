import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { ApiError } from '../../common/api-error.js';
import type { AuthDevice } from '../../common/auth-context.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { consents, devices } from '../../db/schema/index.js';
import { AuditService } from '../access/audit.service.js';
import { deriveConsentStatus, type ConsentStatus } from './consent-status.js';
import { CONSENT_TEXT, CONSENT_TEXT_VERSION } from './consent-text.js';

export type ConsentUpdate =
  | { action: 'grant'; textVersion: string; backfill: boolean }
  | { action: 'revoke' };

/**
 * Đồng ý lại và rút đồng ý của một thiết bị (M3.7, contract `consent.yaml`). Đồng ý lần đầu nằm trong
 * `POST /agent/v1/join`. Chỉ tác động tới thiết bị của device token; token và project không đổi.
 */
@Injectable()
export class ConsentService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Văn bản hiện hành và trạng thái đồng ý của thiết bị. */
  async status(device: AuthDevice): Promise<ConsentStatus> {
    const [rows, [row]] = await Promise.all([
      this.db
        .select({
          textVersion: consents.textVersion,
          backfill: consents.backfill,
          grantedAt: consents.grantedAt,
          revokedAt: consents.revokedAt,
        })
        .from(consents)
        .where(eq(consents.deviceId, device.id)),
      this.db
        .select({ status: devices.status })
        .from(devices)
        .where(eq(devices.id, device.id)),
    ]);
    return deriveConsentStatus({
      rows,
      currentVersion: CONSENT_TEXT_VERSION,
      currentText: CONSENT_TEXT,
      deviceRevoked: row?.status === 'consent_revoked',
    });
  }

  async update(
    device: AuthDevice,
    body: ConsentUpdate,
  ): Promise<ConsentStatus> {
    if (body.action === 'grant') await this.grant(device, body);
    else await this.revoke(device);
    return this.status(device);
  }

  private async grant(
    device: AuthDevice,
    body: Extract<ConsentUpdate, { action: 'grant' }>,
  ): Promise<void> {
    if (body.textVersion !== CONSENT_TEXT_VERSION) {
      throw new ApiError(
        409,
        'consent_outdated',
        'Văn bản đồng ý đã thay đổi, hãy xem lại và đồng ý lại.',
      );
    }
    await this.db.transaction(async (tx) => {
      // Đã đồng ý đúng phiên bản hiện hành thì chỉ cập nhật lựa chọn backfill, không thêm dòng mới.
      const updated = await tx
        .update(consents)
        .set({ backfill: body.backfill })
        .where(
          and(
            eq(consents.deviceId, device.id),
            eq(consents.textVersion, CONSENT_TEXT_VERSION),
            isNull(consents.revokedAt),
          ),
        )
        .returning({ id: consents.id });
      if (updated.length === 0) {
        await tx.insert(consents).values({
          userId: device.userId,
          deviceId: device.id,
          textVersion: body.textVersion,
          backfill: body.backfill,
        });
      }
      // Đồng ý lại thì thiết bị hết trạng thái "đã rút"; heartbeat kế tiếp báo online/paused như thường.
      await tx
        .update(devices)
        .set({ status: 'online' })
        .where(
          and(eq(devices.id, device.id), eq(devices.status, 'consent_revoked')),
        );
      await this.audit.record(
        device.userId,
        'consent.grant',
        'device',
        device.id,
        tx,
      );
    });
  }

  private async revoke(device: AuthDevice): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(consents)
        .set({ revokedAt: new Date() })
        .where(and(eq(consents.deviceId, device.id), isNull(consents.revokedAt)));
      await tx
        .update(devices)
        .set({ status: 'consent_revoked' })
        .where(eq(devices.id, device.id));
      await this.audit.record(
        device.userId,
        'consent.revoke',
        'device',
        device.id,
        tx,
      );
    });
  }
}
