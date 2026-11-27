// Câu lệnh cài `tl` và tham gia project từ link mời. Module thường (không "use client")
// để dùng được cả ở server component (trang /i/<mã>) lẫn client component.

/**
 * Lệnh PowerShell cài `tl` chung cho mọi server, không kèm mã mời (giống `installCommand` của
 * API). Script là asset `install.ps1` của GitHub Releases bản mới nhất, nguồn ở
 * `deploy/install.ps1`: chỉ cài `tl`, tham gia nhóm là bước riêng `tl join <link>`.
 */
export const installCommand =
  "irm https://github.com/MakitJenamin/TeamLens/releases/latest/download/install.ps1 | iex";

/** Lệnh cài `tl` tương đương cho CMD (asset `install.cmd`, nguồn ở `deploy/install.cmd`). */
export const installCommandCmd =
  "curl -fsSL https://github.com/MakitJenamin/TeamLens/releases/latest/download/install.cmd -o install.cmd && install.cmd && del install.cmd";

/** Câu lệnh tham gia project bằng link mời (sau khi máy đã có `tl`). */
export function joinCommand(url: string): string {
  return `tl join ${url}`;
}
