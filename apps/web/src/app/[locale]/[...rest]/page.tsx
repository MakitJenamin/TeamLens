import { notFound } from "next/navigation";

// Mọi đường dẫn không khớp route nào → trang 404 có dịch (not-found.tsx của [locale]).
export default function CatchAllPage() {
  notFound();
}
