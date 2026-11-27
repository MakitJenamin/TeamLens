"use client";

import {
  Legend,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

export interface RadarPoint {
  label: string;
  member: number | undefined;
  team: number | undefined;
}

const tooltipStyle = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--popover-foreground)",
  fontSize: 12,
};

/**
 * Radar 5 nhóm kỹ năng: thành viên (nét liền, tô nhạt, màu chính) so với trung bình team (nét đứt, xám).
 * Hai chuỗi khác nhau cả về màu lẫn kiểu nét nên không phụ thuộc vào màu.
 */
export function ProfileRadar({
  data,
  memberName,
  teamName,
}: {
  data: RadarPoint[];
  memberName: string;
  teamName: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={340}>
      <RadarChart data={data} outerRadius="68%">
        <PolarGrid stroke="var(--border)" />
        <PolarAngleAxis dataKey="label" tick={{ fill: "var(--foreground)", fontSize: 12 }} />
        <PolarRadiusAxis
          // Đặt trục số giữa hai nan để số không đè lên nhãn nhóm ở đỉnh.
          angle={54}
          domain={[0, 100]}
          tickCount={5}
          tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          axisLine={false}
        />
        <Radar
          name={memberName}
          dataKey="member"
          stroke="var(--viz-1)"
          fill="var(--viz-1)"
          fillOpacity={0.25}
          strokeWidth={2}
          dot={{ r: 4, stroke: "var(--background)", strokeWidth: 2, fill: "var(--viz-1)" }}
          isAnimationActive={false}
        />
        <Radar
          name={teamName}
          dataKey="team"
          stroke="var(--muted-foreground)"
          fill="none"
          strokeWidth={2}
          strokeDasharray="6 4"
          isAnimationActive={false}
        />
        <Tooltip contentStyle={tooltipStyle} />
        <Legend
          wrapperStyle={{ fontSize: 12 }}
          formatter={(value) => <span style={{ color: "var(--foreground)" }}>{value}</span>}
        />
      </RadarChart>
    </ResponsiveContainer>
  );
}
