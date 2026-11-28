import { Inject, Injectable } from '@nestjs/common';
import type { SkillCatalogSource } from '@teamlens/schema';
import { asc, eq } from 'drizzle-orm';
import {
  ApiError,
  isUniqueViolation,
  notFound,
} from '../../common/api-error.js';
import type { Database } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { settings, skillCatalogSources } from '../../db/schema/index.js';
import { isUuid } from '../access/access.service.js';
import { AuditService } from '../access/audit.service.js';
import {
  type GithubRepoRef,
  normalizeGithubUrl,
  parseGithubRepoUrl,
} from './catalog-github.js';
import type { CatalogEntry } from './catalog-shortlist.js';
import { parseSkillFrontmatter } from './skill-md.js';

/** Hai nguồn mặc định (AI_PLAN 3.2), thêm đúng một lần ở lần đọc danh sách đầu tiên. */
export const DEFAULT_SOURCES = [
  'https://github.com/anthropics/skills',
  'https://github.com/github/awesome-copilot',
] as const;

const SEEDED_KEY = 'skill_catalog_seeded';
const GITHUB_API = 'https://api.github.com';
const GITHUB_RAW = 'https://raw.githubusercontent.com';
const USER_AGENT = 'teamlens-skill-catalog';

/** Thời gian giữ catalog trong bộ nhớ. */
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
/** Số `SKILL.md` đọc tối đa mỗi nguồn (theo thứ tự đường dẫn). */
export const MAX_SKILLS_PER_SOURCE = 600;
const FETCH_CONCURRENCY = 8;
const TREE_TIMEOUT_MS = 15_000;
const FILE_TIMEOUT_MS = 8_000;
/** Chỉ đọc đầu file: front matter nằm ở đó. */
const FILE_RANGE = 'bytes=0-2047';

const catalogUnavailable = (message: string) =>
  new ApiError(502, 'catalog_unavailable', message);

type SourceRow = typeof skillCatalogSources.$inferSelect;

const toSource = (row: SourceRow): SkillCatalogSource => ({
  id: row.id,
  url: row.url,
  kind: 'github',
  enabled: row.enabled,
  createdAt: row.createdAt.toISOString(),
});

export interface LoadedCatalog {
  entries: CatalogEntry[];
  /** Số nguồn đọc được. */
  sourcesOk: number;
}

/**
 * Nguồn catalog skill cộng đồng và việc đọc catalog từ GitHub (M6.13).
 *
 * Chỉ gọi `api.github.com` và `raw.githubusercontent.com` với `owner/repo` đã kiểm bằng
 * {@link parseGithubRepoUrl}, nên người dùng không điều khiển được host đích. Kết quả đọc được giữ trong bộ nhớ
 * {@link CATALOG_TTL_MS}; lỗi không được nhớ (lần sau thử lại).
 */
@Injectable()
export class SkillCatalogService {
  private readonly cache = new Map<
    string,
    { at: number; entries: CatalogEntry[] }
  >();
  private readonly inflight = new Map<string, Promise<CatalogEntry[]>>();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(): Promise<{ sources: SkillCatalogSource[] }> {
    await this.ensureDefaults();
    const rows = await this.db
      .select()
      .from(skillCatalogSources)
      .orderBy(asc(skillCatalogSources.createdAt), asc(skillCatalogSources.id));
    return { sources: rows.map(toSource) };
  }

  async create(actorId: string, url: string): Promise<SkillCatalogSource> {
    const ref = parseGithubRepoUrl(url);
    if (!ref)
      throw new ApiError(
        400,
        'validation_error',
        'Chỉ nhận URL repo GitHub công khai dạng https://github.com/{owner}/{repo}',
      );
    await this.ensureDefaults();
    const normalized = normalizeGithubUrl(ref);
    try {
      const [row] = await this.db
        .insert(skillCatalogSources)
        .values({ url: normalized, kind: 'github' })
        .returning();
      await this.audit.record(
        actorId,
        'skill_catalog.add',
        'skill_catalog_source',
        row.id,
        this.db,
        { url: normalized },
      );
      return toSource(row);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ApiError(409, 'source_exists', 'Nguồn catalog này đã có.');
      throw error;
    }
  }

  async setEnabled(
    actorId: string,
    id: string,
    enabled: boolean,
  ): Promise<SkillCatalogSource> {
    if (!isUuid(id)) throw notFound('Không tìm thấy nguồn catalog');
    const [row] = await this.db
      .update(skillCatalogSources)
      .set({ enabled })
      .where(eq(skillCatalogSources.id, id))
      .returning();
    if (!row) throw notFound('Không tìm thấy nguồn catalog');
    await this.audit.record(
      actorId,
      'skill_catalog.update',
      'skill_catalog_source',
      id,
      this.db,
      { url: row.url, enabled },
    );
    return toSource(row);
  }

  async remove(actorId: string, id: string): Promise<void> {
    if (!isUuid(id)) throw notFound('Không tìm thấy nguồn catalog');
    const [row] = await this.db
      .delete(skillCatalogSources)
      .where(eq(skillCatalogSources.id, id))
      .returning();
    if (!row) throw notFound('Không tìm thấy nguồn catalog');
    this.cache.delete(row.url);
    await this.audit.record(
      actorId,
      'skill_catalog.remove',
      'skill_catalog_source',
      id,
      this.db,
      { url: row.url },
    );
  }

  /**
   * Đọc catalog từ mọi nguồn đang bật. Một nguồn lỗi thì bỏ qua; không đọc được nguồn nào (hoặc không có nguồn nào
   * đang bật, hoặc không có skill nào) thì `502 catalog_unavailable`.
   */
  async load(): Promise<LoadedCatalog> {
    await this.ensureDefaults();
    const sources = await this.db
      .select()
      .from(skillCatalogSources)
      .where(eq(skillCatalogSources.enabled, true))
      .orderBy(asc(skillCatalogSources.createdAt), asc(skillCatalogSources.id));
    if (sources.length === 0)
      throw catalogUnavailable(
        'Chưa có nguồn catalog nào đang bật. Nhờ leader bật hoặc thêm nguồn ở trang Skill Finder.',
      );

    const settled = await Promise.allSettled(
      sources.map((s) => this.entriesOf(s.url)),
    );
    const entries: CatalogEntry[] = [];
    let sourcesOk = 0;
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      sourcesOk += 1;
      entries.push(...result.value);
    }
    if (sourcesOk === 0 || entries.length === 0)
      throw catalogUnavailable(
        'Không đọc được skill từ nguồn catalog nào. Kiểm tra nguồn đang bật và kết nối tới GitHub.',
      );
    return { entries, sourcesOk };
  }

  /** Thêm hai nguồn mặc định đúng một lần (leader xóa rồi thì không thêm lại). */
  private async ensureDefaults(): Promise<void> {
    const [flag] = await this.db
      .select({ key: settings.key })
      .from(settings)
      .where(eq(settings.key, SEEDED_KEY));
    if (flag) return;
    const now = Date.now();
    await this.db.transaction(async (tx) => {
      await tx
        .insert(skillCatalogSources)
        .values(
          // createdAt lệch nhau 1 ms để thứ tự hiển thị luôn đúng thứ tự khai báo.
          DEFAULT_SOURCES.map((url, i) => ({
            url,
            kind: 'github',
            createdAt: new Date(now + i),
          })),
        )
        .onConflictDoNothing();
      await tx
        .insert(settings)
        .values({ key: SEEDED_KEY, value: true })
        .onConflictDoNothing();
    });
  }

  private entriesOf(url: string): Promise<CatalogEntry[]> {
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS)
      return Promise.resolve(cached.entries);
    const running = this.inflight.get(url);
    if (running) return running;

    const ref = parseGithubRepoUrl(url);
    if (!ref) return Promise.reject(new Error('url không hợp lệ'));
    const promise = this.fetchSource(ref)
      .then((entries) => {
        this.cache.set(url, { at: Date.now(), entries });
        return entries;
      })
      .finally(() => this.inflight.delete(url));
    this.inflight.set(url, promise);
    return promise;
  }

  /** Cây thư mục của repo (một request), rồi đọc đầu mỗi `SKILL.md` để lấy tên và mô tả. */
  private async fetchSource(ref: GithubRepoRef): Promise<CatalogEntry[]> {
    const base = `${ref.owner}/${ref.repo}`;
    const sourceUrl = normalizeGithubUrl(ref);
    const treeRes = await fetch(
      `${GITHUB_API}/repos/${base}/git/trees/HEAD?recursive=1`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': USER_AGENT,
        },
        signal: AbortSignal.timeout(TREE_TIMEOUT_MS),
      },
    );
    if (!treeRes.ok) throw new Error(`GitHub trả ${treeRes.status}`);
    const tree = (await treeRes.json()) as {
      tree?: { path?: unknown; type?: unknown }[];
    };
    const paths = (tree.tree ?? [])
      .filter(
        (node): node is { path: string; type: string } =>
          node.type === 'blob' &&
          typeof node.path === 'string' &&
          (node.path === 'SKILL.md' || node.path.endsWith('/SKILL.md')),
      )
      .map((node) => node.path)
      .sort()
      .slice(0, MAX_SKILLS_PER_SOURCE);

    const entries: (CatalogEntry | null)[] = Array.from(
      { length: paths.length },
      () => null,
    );
    let next = 0;
    const worker = async () => {
      while (next < paths.length) {
        const index = next++;
        entries[index] = await this.readSkill(
          base,
          sourceUrl,
          paths[index],
        ).catch(() => null);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(FETCH_CONCURRENCY, paths.length) }, worker),
    );
    return entries.filter((e): e is CatalogEntry => e !== null);
  }

  private async readSkill(
    base: string,
    sourceUrl: string,
    path: string,
  ): Promise<CatalogEntry | null> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(`${GITHUB_RAW}/${base}/HEAD/${encoded}`, {
      headers: { Range: FILE_RANGE, 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const parts = path.split('/');
    const fallback = parts.length > 1 ? parts[parts.length - 2] : '';
    const parsed = parseSkillFrontmatter(await res.text(), fallback);
    if (!parsed) return null;
    return {
      sourceUrl,
      name: parsed.name,
      description: parsed.description,
      skillUrl: `${sourceUrl}/blob/HEAD/${encoded}`,
    };
  }
}
