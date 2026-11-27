"use client";

import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { VIZ_COLOR_BY_INDEX } from "./viz-colors";

const axisTick = { fill: "var(--muted-foreground)", fontSize: 12 };
const tooltipStyle = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--popover-foreground)",
  fontSize: 12,
};

export interface TokensPoint {
  label: string;
  tokens: number;
}

/** Cột token theo tuần: một chuỗi, nên không cần chú giải (tiêu đề đã nêu). */
export function TokensChart({
  data,
  seriesName,
  formatValue,
}: {
  data: TokensPoint[];
  seriesName: string;
  formatValue: (value: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
        <YAxis tick={axisTick} tickLine={false} axisLine={false} width={48} tickFormatter={formatValue} />
        <Tooltip
          cursor={{ fill: "var(--muted)", opacity: 0.4 }}
          contentStyle={tooltipStyle}
          formatter={(value) => [formatValue(Number(value)), seriesName]}
        />
        <Bar dataKey="tokens" name={seriesName} fill={VIZ_COLOR_BY_INDEX[0]} radius={[4, 4, 0, 0]} maxBarSize={48} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export interface ScoreSeries {
  key: string;
  name: string;
}

/** Đường điểm 5 nhóm theo tuần (0–100). Tuần chưa có điểm để trống, không nối qua khoảng trống. */
export function ScoresChart({
  data,
  series,
}: {
  data: Array<Record<string, string | number | undefined>>;
  series: ScoreSeries[];
}) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
        <YAxis domain={[0, 100]} tick={axisTick} tickLine={false} axisLine={false} width={32} />
        <Tooltip contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {series.map((s, index) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={VIZ_COLOR_BY_INDEX[index]}
            strokeWidth={2}
            dot={{ r: 4, stroke: "var(--background)", strokeWidth: 2, fill: VIZ_COLOR_BY_INDEX[index] }}
            activeDot={{ r: 5 }}
            connectNulls={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
