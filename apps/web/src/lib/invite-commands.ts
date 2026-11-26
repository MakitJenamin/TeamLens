// Câu lệnh tham gia project từ link mời. Module thường (không "use client")
// để dùng được cả ở server component (trang /i/<mã>) lẫn client component.

/** Câu lệnh tham gia khi máy đã có `tl`. */
export function joinCommand(url: string): string {
  return `tl join ${url}`;
}

/** Câu lệnh PowerShell cài `tl` rồi tự tham gia (giống `installCommand` của API). */
export function installCommand(origin: string, code: string): string {
  return `irm ${origin}/install.ps1?code=${code} | iex`;
}
