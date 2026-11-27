/**
 * Màu biểu đồ: 5 slot đầu của palette phân loại tham chiếu (skill `dataviz`), đã chạy
 * `validate_palette.js` ở cả chế độ sáng và tối (xanh dương, cam, xanh ngọc, vàng, hồng).
 * Gán theo thứ tự cố định cho 5 nhóm kỹ năng; không dùng màu trạng thái. Chế độ tối dùng bước màu riêng.
 * Chế độ sáng có 3 màu dưới 3:1 so với nền, nên trang luôn kèm chú giải, tooltip và bảng số liệu.
 */
export const VIZ_VARS =
  "[--viz-1:#2a78d6] [--viz-2:#eb6834] [--viz-3:#1baf7a] [--viz-4:#eda100] [--viz-5:#e87ba4] " +
  "dark:[--viz-1:#3987e5] dark:[--viz-2:#d95926] dark:[--viz-3:#199e70] dark:[--viz-4:#c98500] dark:[--viz-5:#d55181]";

export const VIZ_COLOR_BY_INDEX = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)"] as const;
