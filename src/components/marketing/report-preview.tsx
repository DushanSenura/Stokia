"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from "recharts";

// Illustrative shape only. Labelled "sample" wherever it is shown; never real shop data.
const SAMPLE = [
  { d: "1", v: 4200 }, { d: "2", v: 3600 }, { d: "3", v: 5100 }, { d: "4", v: 2900 },
  { d: "5", v: 4700 }, { d: "6", v: 6100 }, { d: "7", v: 5300 },
];

export function ReportPreviewChart() {
  return (
    <div className="h-56 w-full" role="img" aria-label="Sample bar chart of daily estimated sales">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={SAMPLE} margin={{ top: 8, right: 4, left: -16, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="d" tickLine={false} axisLine={false} tick={{ fill: "var(--muted)", fontSize: 12 }} />
          <YAxis tickLine={false} axisLine={false} tick={{ fill: "var(--muted)", fontSize: 12 }} />
          <Bar dataKey="v" fill="var(--primary)" radius={[8, 8, 0, 0]} animationDuration={600} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
