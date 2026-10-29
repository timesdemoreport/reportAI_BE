// Golden test set for the Report Writer planner.
// Each case: the user question, a human-written expected intent (for the LLM judge),
// optional `assert` for exact structured-field checks, and optional `ctx` (previous report)
// for follow-up cases.

const prevTurnoverReport = {
  previousReport: {
    title: "Turnover rate by department (2025)",
    narrative: "Turnover rose mainly in Sales (21%).",
    kpis: [{ label: "Overall turnover", value: "7.1%" }],
    series: [
      { label: "Sales", value: 21 },
      { label: "Engineering", value: 8 },
    ],
    spec: {
      metric: "turnover_rate",
      group_by: "department",
      period_from: "2025-01-01",
      period_to: "2025-12-31",
      compare: false,
      chart_type: "bar",
    },
    calc: {
      formula: "turnover = leavers ÷ average headcount × 100",
      expr: "12 ÷ 169 × 100 = 7.1%",
      latex: "\\text{turnover} = \\frac{12}{169} \\times 100 = 7.1\\%",
    },
  },
};

export const goldenTests = [
  {
    id: "turnover-by-dept",
    question: "turnover by department 2025",
    expected:
      "A turnover_rate report grouped by department for calendar year 2025, no comparison. action=report.",
    assert: { action: "report", metric: "turnover_rate", group_by: "department" },
  },
  {
    id: "turnover-compare-2y",
    question: "turnover by department 2024 vs 2025",
    expected:
      "A turnover_rate report by department comparing calendar year 2024 with 2025. action=report, compare=true, periods are 2024 and 2025.",
    assert: { action: "report", metric: "turnover_rate", compare: true },
  },
  {
    id: "turnover-multi-year",
    question: "compare turnover for 2023, 2024 and 2025",
    expected:
      "A company-level turnover_rate report across three years (2023, 2024, 2025). action=report, group_by=none, years contains all three years.",
    assert: { action: "report", metric: "turnover_rate", group_by: "none" },
  },
  {
    id: "retention",
    question: "retention rate by department 2025",
    expected: "A retention_rate report grouped by department for 2025. action=report.",
    assert: { action: "report", metric: "retention_rate" },
  },
  {
    id: "headcount-growth",
    question: "headcount growth in 2025",
    expected: "A headcount_growth report for 2025. action=report.",
    assert: { action: "report", metric: "headcount_growth" },
  },
  {
    id: "average-headcount",
    question: "average headcount by department 2025",
    expected: "An average_headcount report grouped by department for 2025. action=report.",
    assert: { action: "report", metric: "average_headcount" },
  },
  {
    id: "leave",
    question: "leave utilization by department 2025",
    expected: "A leave_utilization report grouped by department for 2025. action=report.",
    assert: { action: "report", metric: "leave_utilization" },
  },
  {
    id: "distribution-pie",
    question: "show the headcount distribution across departments for 2025",
    expected:
      "A headcount distribution across departments for 2025, shown as a pie. Headcount count uses metric average_headcount. action=report, metric=average_headcount, chart_type=pie.",
    assert: { action: "report", metric: "average_headcount", chart_type: "pie" },
  },
  {
    id: "overall-kpi",
    question: "what is our overall turnover in 2025?",
    expected:
      "A single overall turnover figure for 2025, no breakdown. action=report, group_by=none, chart_type=kpi_number.",
    assert: { action: "report", metric: "turnover_rate", group_by: "none" },
  },
  {
    id: "clarify-missing-period",
    question: "generate a turnover rate report",
    expected:
      "The period is missing, so the assistant must ask which time period to use. action=clarify.",
    assert: { action: "clarify" },
  },
  {
    id: "greeting",
    question: "hi",
    expected: "A friendly greeting; no report. action=chat.",
    assert: { action: "chat" },
  },
  {
    id: "off-topic",
    question: "what's the weather today?",
    expected:
      "Off-topic; the assistant should politely say it only helps with HR reports. action=chat.",
    assert: { action: "chat" },
  },
  {
    id: "simulate-raise",
    question: "what if we give Sales a 10% raise?",
    expected:
      "A what-if pay-raise simulation for the Sales department at 10%. action=simulate, sim_target=Sales, sim_percent=10.",
    assert: { action: "simulate" },
  },
  {
    id: "simulate-missing-percent",
    question: "what if we give Sales a raise?",
    expected:
      "A raise simulation but the percentage is missing, so the assistant should ask for it. action=clarify.",
    assert: { action: "clarify" },
  },
  {
    id: "followup-chart-change",
    question: "show it as a pie chart",
    ctx: prevTurnoverReport,
    expected:
      "Adjusts the previous turnover report to a pie chart, keeping the same metric/period. action=report, chart_type=pie, metric=turnover_rate.",
    assert: { action: "report", chart_type: "pie", metric: "turnover_rate" },
  },
  {
    id: "followup-correction",
    question: "I mean 2022 vs 2023",
    ctx: prevTurnoverReport,
    expected:
      "Corrects the comparison to calendar years 2022 vs 2023 for the same turnover report. action=report, compare=true, one period is 2022 and the other 2023.",
    assert: { action: "report", compare: true },
  },
  {
    id: "followup-calc",
    question: "how did you get that number?",
    ctx: prevTurnoverReport,
    expected:
      "A follow-up asking how the figure was calculated; should explain using the report (not regenerate a chart). action=chat.",
    assert: { action: "chat" },
  },
];
