import client from "../config/openai.js";
import metricRepository from "../repositories/metricRepository.js";

// Routing + spec extraction — keep this fast/cheap, mini is plenty.
const PLANNER_MODEL = "gpt-4o-mini";
// Narrative + advice — bump this one for richer write-ups (e.g. "gpt-4o" or "gpt-4.1").
const NARRATIVE_MODEL = "gpt-4o-mini";
const PLANNER_TEMPERATURE = 0.5; // low = reliable date/intent extraction
const NARRATIVE_TEMPERATURE = 0.7;

const METRICS = [
  "turnover_rate",
  "retention_rate",
  "headcount_growth",
  "average_headcount",
  "leave_utilization",
];

const PLANNER_SCHEMA = {
  name: "report_plan",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["chat", "clarify", "report"] },
      reply: {
        type: "string",
        description:
          "Message to show the user for 'chat' or 'clarify'. Empty string when action is 'report'.",
      },
      metric: { type: "string", enum: METRICS },
      group_by: {
        type: "string",
        enum: ["department", "job_grade", "gender", "none"],
      },
      chart_type: {
        type: "string",
        enum: ["bar", "line", "pie", "kpi_number"],
      },
      period_from: { type: "string", description: "YYYY-MM-DD or empty" },
      period_to: { type: "string", description: "YYYY-MM-DD or empty" },
      compare: { type: "boolean" },
      compare_from: { type: "string", description: "YYYY-MM-DD or empty" },
      compare_to: { type: "string", description: "YYYY-MM-DD or empty" },
    },
    required: [
      "action",
      "reply",
      "metric",
      "group_by",
      "chart_type",
      "period_from",
      "period_to",
      "compare",
      "compare_from",
      "compare_to",
    ],
  },
};

const NARRATIVE_SCHEMA = {
  name: "report_narrative",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      narrative: { type: "string" },
      prediction: { type: "string" },
      advice: { type: "array", items: { type: "string" } },
    },
    required: ["narrative", "prediction", "advice"],
  },
};

function addUsage(acc, completion) {
  const u = completion.usage || {};
  acc.prompt_tokens += u.prompt_tokens || 0;
  acc.completion_tokens += u.completion_tokens || 0;
  acc.total_tokens += u.total_tokens || 0;
}

async function callPlanner(question, ctx) {
  const system = `You are the Report Writer assistant inside an HR system. You help HR build and understand workforce reports: turnover rate, retention rate, headcount growth, average headcount, and leave utilization. You are friendly and conversational, but you stay on the topic of HR reporting.

Choose an action for each user message:
- "report": the user wants a report and you have enough detail. Fill the spec fields.
- "clarify": the user wants a report but a required detail is missing. Ask ONE short, specific question in "reply". Every report needs at least a time period (a year or date range); if it's missing, ask for it. Ask only one question.
- "chat": anything else — greetings, small talk, "what can you do", OR a follow-up question about a report you already produced (e.g. "any other recommended actions?", "why is it high?", "explain that"). Put your answer in "reply".
  - Greetings / capability questions: a short, warm, VARIED reply that invites them to ask for a report.
  - Follow-up questions about the most recent report (given below): answer specifically using that report's data; give additional, DIFFERENT actions or explain the drivers. Never repeat a generic greeting, and do not regenerate the chart.
  - If the user asks HOW a figure was calculated (e.g. "how did you get 7.1%?"), use the report's "calc" field to show the actual worked arithmetic. Present the equation on its own line as LaTeX wrapped in $$ ... $$ (use calc.latex), then add one short plain-English sentence explaining it. Do not invent numbers — only use the ones in calc.
  - Off-topic: politely say you only help with HR reports.

Rules:
- Dates are YYYY-MM-DD. Treat a bare year (e.g. 2023) as that FULL calendar year: 2023-01-01 to 2023-12-31. Never use a rolling 12-month window unless the user explicitly asks for one.
- For a comparison like "A vs B" (e.g. "2022 vs 2023"), set period = full calendar year A and compare = full calendar year B, using EXACTLY the two years the user named. Set compare=true. If the user corrects the years ("I mean 2022 vs 2023"), use the corrected years and ignore any earlier ones. Otherwise compare=false and set compare_from/compare_to to "".
- chart_type options: bar (compare categories), line (trend), pie (share of a whole), kpi_number (single figure). Pick a sensible default, usually bar.
- For "chat"/"clarify", still fill spec fields with safe defaults (ignored); keep unknown periods "".
- If a previous spec is provided and the user is adjusting it ("now 2023 vs 2024", "by gender", "same but retention", "show as a pie chart", "make it a line", "add a comparison to 2024"), apply the change and choose "report". A request like "show it as a pie" only changes chart_type.`;

  const messages = [{ role: "system", content: system }];

  if (ctx.previousReport) {
    messages.push({
      role: "system",
      content: `Most recent report you produced (use this for follow-up questions): ${JSON.stringify(
        {
          title: ctx.previousReport.title,
          narrative: ctx.previousReport.narrative,
          prediction: ctx.previousReport.prediction,
          advice: ctx.previousReport.advice,
          kpis: ctx.previousReport.kpis,
          series: ctx.previousReport.series,
          spec: ctx.previousReport.spec,
          calc: ctx.previousReport.calc,
        },
      )}`,
    });
  }

  for (const h of ctx.history || []) {
    if (h.role === "user" || h.role === "assistant") {
      messages.push({ role: h.role, content: h.content });
    }
  }
  messages.push({ role: "user", content: question });

  return client.chat.completions.create({
    model: PLANNER_MODEL,
    temperature: PLANNER_TEMPERATURE,
    messages,
    response_format: { type: "json_schema", json_schema: PLANNER_SCHEMA },
  });
}

async function callNarrative(metric, facts) {
  const system = `You are an HR analytics assistant. The metric is "${metric}". Using ONLY the facts provided (never invent numbers), write:
- narrative: 1-2 plain-English sentences summarizing the key finding for a non-technical HR user. If two periods are compared, state the change between them. Name the most notable group.
- prediction: 1 forward-looking sentence, clearly phrased as an estimate.
- advice: 2-3 short, concrete HR actions relevant to this metric and finding.
Refer to the period(s) exactly as given in the facts; never invent specific months or dates.`;

  return client.chat.completions.create({
    model: NARRATIVE_MODEL,
    temperature: NARRATIVE_TEMPERATURE,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(facts) },
    ],
    response_format: { type: "json_schema", json_schema: NARRATIVE_SCHEMA },
  });
}

// ---- helpers ----
function pct(num, den) {
  return den > 0 ? Math.round((num / den) * 1000) / 10 : 0;
}
function sumBy(rows, key) {
  return rows.reduce((a, r) => a + Number(r[key]), 0);
}
function highlight(series, lowest = false) {
  if (!series.length) return;
  const pick = series.reduce((a, b) =>
    lowest ? (b.value < a.value ? b : a) : b.value > a.value ? b : a,
  );
  pick.highlight = true;
  series.sort((a, b) => b.value - a.value);
}
function yr(dateStr) {
  return (dateStr || "").slice(0, 4);
}
function yearLabel(spec) {
  const y1 = yr(spec.period_from);
  if (spec.compare && spec.compare_from)
    return `${y1} vs ${yr(spec.compare_from)}`;
  return y1;
}
function groupLabel(groupBy) {
  return groupBy === "none" ? "company" : groupBy.replace("_", " ");
}

// Build the worked calculation for the OVERALL figure so follow-ups can explain it.
function buildCalc(metric, rows, overall) {
  const n = (k) => sumBy(rows, k);
  switch (metric) {
    case "turnover_rate": {
      const l = n("leavers");
      const e = n("exposed");
      return {
        formula: "turnover = leavers ÷ average headcount × 100",
        expr: `${l} ÷ ${e} × 100 = ${overall}%`,
        latex: `\\text{turnover} = \\frac{${l}}{${e}} \\times 100 = ${overall}\\%`,
      };
    }
    case "retention_rate": {
      const r = n("retained_count");
      const s = n("start_count");
      return {
        formula: "retention = still employed ÷ starting headcount × 100",
        expr: `${r} ÷ ${s} × 100 = ${overall}%`,
        latex: `\\text{retention} = \\frac{${r}}{${s}} \\times 100 = ${overall}\\%`,
      };
    }
    case "headcount_growth": {
      const s = n("start_count");
      const e = n("end_count");
      return {
        formula: "growth = (end − start) ÷ start × 100",
        expr: `(${e} − ${s}) ÷ ${s} × 100 = ${overall}%`,
        latex: `\\text{growth} = \\frac{${e} - ${s}}{${s}} \\times 100 = ${overall}\\%`,
      };
    }
    case "average_headcount": {
      const s = n("start_count");
      const e = n("end_count");
      return {
        formula: "average headcount = (start + end) ÷ 2",
        expr: `(${s} + ${e}) ÷ 2 = ${overall}`,
        latex: `\\text{avg headcount} = \\frac{${s} + ${e}}{2} = ${overall}`,
      };
    }
    case "leave_utilization": {
      const t = n("taken_days");
      const en = n("entitled_days");
      return {
        formula: "leave utilization = days taken ÷ days entitled × 100",
        expr: `${t} ÷ ${en} × 100 = ${overall}%`,
        latex: `\\text{leave utilization} = \\frac{${t}}{${en}} \\times 100 = ${overall}\\%`,
      };
    }
    default:
      return null;
  }
}

// ---- metric definitions ----
const METRIC_META = {
  turnover_rate: {
    name: "Turnover rate",
    unit: "%",
    yLabel: "Turnover %",
    kpiLabel: "Overall turnover",
    isPercent: true,
    highlightLowest: false,
    rows: (dim, from, to) => metricRepository.turnoverRows(dim, from, to),
    value: (r) => pct(Number(r.leavers), Number(r.exposed)),
    overall: (rows) => pct(sumBy(rows, "leavers"), sumBy(rows, "exposed")),
    drivers: true,
  },
  retention_rate: {
    name: "Retention rate",
    unit: "%",
    yLabel: "Retention %",
    kpiLabel: "Overall retention",
    isPercent: true,
    highlightLowest: true,
    rows: (dim, from, to) => metricRepository.retentionRows(dim, from, to),
    value: (r) => pct(Number(r.retained_count), Number(r.start_count)),
    overall: (rows) =>
      pct(sumBy(rows, "retained_count"), sumBy(rows, "start_count")),
  },
  headcount_growth: {
    name: "Headcount growth",
    unit: "%",
    yLabel: "Growth %",
    kpiLabel: "Growth",
    isPercent: true,
    highlightLowest: false,
    rows: (dim, from, to) => metricRepository.headcountRows(dim, from, to),
    value: (r) => {
      const s = Number(r.start_count);
      const e = Number(r.end_count);
      return s > 0 ? Math.round(((e - s) / s) * 1000) / 10 : 0;
    },
    overall: (rows) => {
      const s = sumBy(rows, "start_count");
      const e = sumBy(rows, "end_count");
      return s > 0 ? Math.round(((e - s) / s) * 1000) / 10 : 0;
    },
  },
  average_headcount: {
    name: "Average headcount",
    unit: "",
    yLabel: "Headcount",
    kpiLabel: "Average headcount",
    isPercent: false,
    highlightLowest: false,
    rows: (dim, from, to) => metricRepository.headcountRows(dim, from, to),
    value: (r) => Math.round((Number(r.start_count) + Number(r.end_count)) / 2),
    overall: (rows) =>
      Math.round((sumBy(rows, "start_count") + sumBy(rows, "end_count")) / 2),
  },
  leave_utilization: {
    name: "Leave utilization",
    unit: "%",
    yLabel: "Leave utilization %",
    kpiLabel: "Overall leave utilization",
    isPercent: true,
    highlightLowest: false,
    rows: (dim, from, to) => metricRepository.leaveRows(dim, from, to),
    value: (r) => pct(Number(r.taken_days), Number(r.entitled_days)),
    overall: (rows) =>
      pct(sumBy(rows, "taken_days"), sumBy(rows, "entitled_days")),
  },
};

async function computeMetric(spec) {
  const meta = METRIC_META[spec.metric];
  if (!meta) return null;

  const rows = await meta.rows(spec.group_by, spec.period_from, spec.period_to);
  let series = rows.map((r) => ({ label: r.label, value: meta.value(r) }));
  const overall = meta.overall(rows);

  // Comparison: compute the same metric for the compare period and attach a 2nd value per group
  let overallCompare = null;
  let compareLabel = null;
  const periodLabel = yr(spec.period_from);
  if (spec.compare && spec.compare_from && spec.compare_to) {
    const rows2 = await meta.rows(
      spec.group_by,
      spec.compare_from,
      spec.compare_to,
    );
    const map2 = Object.fromEntries(rows2.map((r) => [r.label, meta.value(r)]));
    series = series.map((s) => ({ ...s, compareValue: map2[s.label] ?? 0 }));
    overallCompare = meta.overall(rows2);
    compareLabel = yr(spec.compare_from);
  }

  highlight(series, meta.highlightLowest);

  const calc = buildCalc(spec.metric, rows, overall);

  // KPI
  const fmtOverall =
    meta.isPercent && spec.metric === "headcount_growth"
      ? `${overall >= 0 ? "+" : ""}${overall}%`
      : meta.isPercent
        ? `${overall}%`
        : String(overall);
  const kpi = { label: meta.kpiLabel, value: fmtOverall };
  if (overallCompare != null) {
    const diff = Math.round((overall - overallCompare) * 10) / 10;
    kpi.trend = meta.isPercent
      ? `${diff >= 0 ? "+" : ""}${diff} pts`
      : `${diff >= 0 ? "+" : ""}${diff}`;
  }

  // Drivers (turnover only) for a richer narrative
  const facts = {
    metric: spec.metric,
    grouped_by: spec.group_by,
    period: `${spec.period_from} to ${spec.period_to}`,
    compare_period: spec.compare
      ? `${spec.compare_from} to ${spec.compare_to}`
      : null,
    overall,
    overall_compare: overallCompare,
    calc,
    by_group: series.map((s) => ({
      label: s.label,
      value: s.value,
      ...(s.compareValue !== undefined ? { compareValue: s.compareValue } : {}),
    })),
  };
  if (meta.drivers) {
    const d = await metricRepository.leaverDrivers(
      spec.period_from,
      spec.period_to,
    );
    facts.leaver_total = Number(d.total_leavers);
    facts.leaver_never_raised = Number(d.never_raised);
    facts.leaver_avg_tenure_months = Number(d.avg_tenure_months);
  }

  return {
    series,
    kpis: [kpi],
    unit: meta.unit,
    y_label: meta.yLabel,
    title: `${meta.name} by ${groupLabel(spec.group_by)} (${yearLabel(spec)})`,
    period_label: periodLabel,
    compare_label: compareLabel,
    calc,
    facts,
  };
}

const reportService = {
  async handleMessage(question, ctx = {}) {
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    const planCompletion = await callPlanner(question, ctx);
    addUsage(usage, planCompletion);
    const p = JSON.parse(planCompletion.choices[0].message.content);

    if (p.action === "chat" || p.action === "clarify") {
      return {
        type: "message",
        content: p.reply || "How can I help with your HR report?",
        usage,
        model: PLANNER_MODEL,
      };
    }

    const spec = {
      metric: p.metric,
      group_by: p.group_by,
      chart_type: p.chart_type,
      period_from: p.period_from,
      period_to: p.period_to,
      compare: p.compare,
      compare_from: p.compare_from,
      compare_to: p.compare_to,
    };

    if (!spec.period_from || !spec.period_to) {
      return {
        type: "message",
        content:
          "Sure — which time period should I report on? For example, a single year like 2025, or a comparison like 2025 vs 2024.",
        usage,
        model: PLANNER_MODEL,
      };
    }

    const result = await computeMetric(spec);
    if (!result) {
      return {
        type: "message",
        content: `I can't build "${spec.metric}" yet. I support turnover, retention, headcount growth, average headcount, and leave utilization.`,
        usage,
        model: PLANNER_MODEL,
      };
    }

    const narrativeCompletion = await callNarrative(spec.metric, result.facts);
    addUsage(usage, narrativeCompletion);
    const narrative = JSON.parse(
      narrativeCompletion.choices[0].message.content,
    );

    const report_data = {
      spec,
      chart_type: spec.chart_type || "bar",
      unit: result.unit,
      title: result.title,
      y_label: result.y_label,
      period_label: result.period_label,
      compare_label: result.compare_label,
      calc: result.calc,
      series: result.series,
      kpis: result.kpis,
      narrative: narrative.narrative,
      prediction: narrative.prediction,
      advice: narrative.advice,
    };

    return {
      type: "report",
      content: narrative.narrative,
      report_data,
      usage,
      model: NARRATIVE_MODEL,
    };
  },
};

export default reportService;
