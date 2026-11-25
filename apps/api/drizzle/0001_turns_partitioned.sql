-- Migration viết tay: chuyển bảng `turns` sang partition theo tháng của `ts`.
--
-- Drizzle không khai báo được PARTITION BY, nên 0000_init tạo `turns` là bảng thường
-- (để snapshot của drizzle-kit khớp với schema trong src/db/schema/sessions.ts).
-- Ở đây xóa bảng đó (lúc này chưa có dữ liệu) và tạo lại dạng partitioned, giữ nguyên
-- tên cột, tên ràng buộc và tên index để các lần `db:generate` sau không thấy khác biệt.
--
-- Vì sao PK là (session_id, seq, ts) thay vì (session_id, seq) như spec:
-- Postgres bắt buộc mọi PRIMARY KEY/UNIQUE trên bảng partitioned phải chứa toàn bộ cột
-- khóa partition (`ts`). Ts của một turn không đổi giữa các lần CLI gửi lại, nên ingest
-- vẫn upsert idempotent được bằng ON CONFLICT (session_id, seq, ts).
--
-- Retention (B11) xóa dữ liệu cũ bằng cách DROP partition của tháng quá hạn.

DROP TABLE "turns";
--> statement-breakpoint
CREATE TABLE "turns" (
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"kind" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"model" text,
	"text" text,
	"tool" jsonb,
	"output" jsonb,
	"diff" jsonb,
	"usage" jsonb,
	"attachments" jsonb,
	"redactions" jsonb,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("text", ''))) STORED,
	CONSTRAINT "turns_pkey" PRIMARY KEY("session_id","seq","ts")
) PARTITION BY RANGE ("ts");
--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "turns_tsv_idx" ON "turns" USING gin ("tsv");
--> statement-breakpoint
-- Tạo partition tháng cho `turns`, từ tháng chứa `from_ts` tới `months_ahead` tháng sau.
-- Tên partition: turns_yYYYYmMM. Chạy lại nhiều lần an toàn (bỏ qua partition đã có).
-- Job hằng đêm và ingest (khi nhận session cũ) gọi hàm này trước khi ghi.
CREATE OR REPLACE FUNCTION ensure_turns_partitions(
	from_ts timestamptz DEFAULT now(),
	months_ahead integer DEFAULT 2
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
	month_start date := date_trunc('month', from_ts AT TIME ZONE 'UTC')::date;
	part_start date;
	part_end date;
	part_name text;
BEGIN
	FOR i IN 0..months_ahead LOOP
		part_start := (month_start + make_interval(months => i))::date;
		part_end := (part_start + interval '1 month')::date;
		part_name := format('turns_y%sm%s', to_char(part_start, 'YYYY'), to_char(part_start, 'MM'));
		IF to_regclass(format('public.%I', part_name)) IS NULL THEN
			EXECUTE format(
				'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.turns FOR VALUES FROM (%L) TO (%L)',
				part_name,
				part_start::timestamp AT TIME ZONE 'UTC',
				part_end::timestamp AT TIME ZONE 'UTC'
			);
		END IF;
	END LOOP;
END;
$$;
--> statement-breakpoint
-- Tháng hiện tại và 2 tháng tới.
SELECT ensure_turns_partitions();
