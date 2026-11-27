import type { Schemas } from '@teamlens/schema';

export type ConsentStatus = Schemas['ConsentStatus'];
export type ConsentState = Schemas['ConsentState'];

/** Một dòng bảng `consents` của thiết bị. */
export interface ConsentRow {
  textVersion: string;
  backfill: boolean;
  grantedAt: Date;
  revokedAt: Date | null;
}

/**
 * Trạng thái đồng ý của một thiết bị so với văn bản hiện hành (contract `consent.yaml`):
 * - `granted`: có bản chưa rút đúng phiên bản hiện hành (cùng điều kiện ingest chấp nhận);
 * - `outdated`: có bản chưa rút nhưng chỉ là phiên bản cũ;
 * - `revoked`: không còn bản nào chưa rút và đã từng rút (có dòng đã rút, hoặc thiết bị đang `consent_revoked`);
 * - `none`: chưa từng có bản đồng ý nào.
 *
 * `acceptedVersion`, `backfill`, `grantedAt` lấy từ bản chưa rút mới nhất (ưu tiên bản đúng phiên bản hiện hành);
 * `revokedAt` là lần rút gần nhất, chỉ có khi `revoked`.
 */
export function deriveConsentStatus(input: {
  rows: readonly ConsentRow[];
  currentVersion: string;
  currentText: string;
  deviceRevoked: boolean;
}): ConsentStatus {
  const { rows, currentVersion, currentText, deviceRevoked } = input;
  const active = rows.filter((row) => row.revokedAt === null);
  const current = active.filter((row) => row.textVersion === currentVersion);
  const pool = current.length > 0 ? current : active;
  const latest = [...pool].sort(
    (a, b) => b.grantedAt.getTime() - a.grantedAt.getTime(),
  )[0];

  let status: ConsentState;
  if (current.length > 0) status = 'granted';
  else if (active.length > 0) status = 'outdated';
  else if (rows.length > 0 || deviceRevoked) status = 'revoked';
  else status = 'none';

  const revokedTimes = rows
    .map((row) => row.revokedAt?.getTime())
    .filter((time): time is number => time !== undefined);
  const lastRevoked =
    status === 'revoked' && revokedTimes.length > 0
      ? new Date(Math.max(...revokedTimes))
      : null;

  return {
    textVersion: currentVersion,
    text: currentText,
    status,
    acceptedVersion: latest?.textVersion ?? null,
    backfill: latest?.backfill ?? null,
    grantedAt: latest?.grantedAt.toISOString() ?? null,
    revokedAt: lastRevoked?.toISOString() ?? null,
  };
}
