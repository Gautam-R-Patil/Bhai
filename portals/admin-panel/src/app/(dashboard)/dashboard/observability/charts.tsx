"use client";

import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

// ── Types ─────────────────────────────────────────

interface RequestOverTime {
  date: string;
  requests: number;
}

interface ActivityType {
  name: string;
  value: number;
}

interface TierData {
  name: string;
  credits: number;
  color: string;
  models: number;
}

interface PlanData {
  name: string;
  users: number;
  credits: number;
}

interface ObservabilityChartsProps {
  requestsOverTime: RequestOverTime[];
  activityTypeData: ActivityType[];
  tierData: TierData[];
  planData: PlanData[];
}

// ── Color Palette ─────────────────────────────────

const CHART_COLORS = [
  "#0066cc",
  "#34c759",
  "#ff9500",
  "#ff3b30",
  "#af52de",
  "#5856d6",
  "#ff2d55",
  "#00c7be",
  "#30b0c7",
  "#a2845e",
];

const PIE_COLORS = ["#34c759", "#ff9500", "#0066cc", "#ff3b30"];

// ── Custom Tooltip ────────────────────────────────

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="bg-white/95 backdrop-blur-xl rounded-xl border border-black/5 shadow-lg px-4 py-3">
      <p className="text-xs font-medium text-[--text-muted] mb-1.5">{label}</p>
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2">
          <div
            className="w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-sm text-[--text-secondary]">{entry.name}:</span>
          <span className="text-sm font-semibold text-[--text-primary]">
            {entry.value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Charts Component ──────────────────────────────

export function ObservabilityCharts({
  requestsOverTime,
  activityTypeData,
  tierData,
  planData,
}: ObservabilityChartsProps) {
  // Format dates for X axis
  const formattedRequests = requestsOverTime.map((d) => ({
    ...d,
    label: new Date(d.date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
  }));

  return (
    <div className="space-y-6">
      {/* Row 1: Line chart + Bar chart */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Requests Over Time (Line Chart) */}
        <div className="glass-card-static p-6">
          <h3 className="text-base font-semibold text-[--text-primary] mb-4">
            Activity Over Time (14 days)
          </h3>
          <div className="h-72">
            {formattedRequests.some((d) => d.requests > 0) ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={formattedRequests}
                  margin={{ top: 5, right: 20, left: 0, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: "#86868b" }}
                    tickLine={false}
                    axisLine={{ stroke: "rgba(0,0,0,0.06)" }}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "#86868b" }}
                    tickLine={false}
                    axisLine={false}
                    width={40}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Line
                    type="monotone"
                    dataKey="requests"
                    name="Activity"
                    stroke="#0066cc"
                    strokeWidth={2.5}
                    dot={{ r: 3, fill: "#0066cc", strokeWidth: 0 }}
                    activeDot={{ r: 5, fill: "#0066cc", strokeWidth: 2, stroke: "#fff" }}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-[--text-muted] text-sm">
                No activity data yet. Data populates as the system is used.
              </div>
            )}
          </div>
        </div>

        {/* Activity By Type (Bar Chart) */}
        <div className="glass-card-static p-6">
          <h3 className="text-base font-semibold text-[--text-primary] mb-4">
            Activity Distribution
          </h3>
          <div className="h-72">
            {activityTypeData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={activityTypeData}
                  layout="vertical"
                  margin={{ top: 5, right: 20, left: 0, bottom: 5 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    horizontal={false}
                    stroke="rgba(0,0,0,0.06)"
                  />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 11, fill: "#86868b" }}
                    tickLine={false}
                    axisLine={{ stroke: "rgba(0,0,0,0.06)" }}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fontSize: 11, fill: "#86868b" }}
                    tickLine={false}
                    axisLine={false}
                    width={100}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="value" name="Count" radius={[0, 6, 6, 0]}>
                    {activityTypeData.map((_, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={CHART_COLORS[index % CHART_COLORS.length]}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-[--text-muted] text-sm">
                No activity breakdown data available yet.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Row 2: Pie charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Cost Tier Breakdown (Pie Chart) */}
        <div className="glass-card-static p-6">
          <h3 className="text-base font-semibold text-[--text-primary] mb-4">
            Model Cost Tier Distribution
          </h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={tierData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={4}
                  dataKey="models"
                  nameKey="name"
                  label={({ name, models }) => `${name}: ${models}`}
                  labelLine={{ stroke: "#86868b", strokeWidth: 1 }}
                >
                  {tierData.map((entry, index) => (
                    <Cell
                      key={`tier-${index}`}
                      fill={entry.color || PIE_COLORS[index % PIE_COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: number, name: string) => [
                    `${value} models`,
                    name,
                  ]}
                />
                <Legend
                  verticalAlign="bottom"
                  height={36}
                  iconType="circle"
                  iconSize={8}
                  formatter={(value) => (
                    <span className="text-xs text-[--text-secondary]">{value}</span>
                  )}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Credits by Plan (Pie Chart) */}
        <div className="glass-card-static p-6">
          <h3 className="text-base font-semibold text-[--text-primary] mb-4">
            Credits by Plan
          </h3>
          <div className="h-72">
            {planData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={planData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={4}
                    dataKey="credits"
                    nameKey="name"
                    label={({ name, users }) => `${name}: ${users} users`}
                    labelLine={{ stroke: "#86868b", strokeWidth: 1 }}
                  >
                    {planData.map((_, index) => (
                      <Cell
                        key={`plan-${index}`}
                        fill={CHART_COLORS[index % CHART_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number, name: string) => [
                      `${value.toLocaleString()} credits`,
                      name,
                    ]}
                  />
                  <Legend
                    verticalAlign="bottom"
                    height={36}
                    iconType="circle"
                    iconSize={8}
                    formatter={(value) => (
                      <span className="text-xs text-[--text-secondary]">{value}</span>
                    )}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-[--text-muted] text-sm">
                No plan data available.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
