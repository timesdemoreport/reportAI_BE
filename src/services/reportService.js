import client from "../config/openai.js";
import metricRepository from "../repositories/metricRepository.js";

// Routing + spec extraction — keep this fast/cheap, mini is plenty.
const PLANNER_MODEL = "gpt-4o";
// Narrative + advice — bump this one for richer write-ups (e.g. "gpt-4o" or "gpt-4.1").
const NARRATIVE_MODEL = "gpt-4o-mini";
const PLANNER_TEMPERATURE = 0.2; // low = reliable date/intent extraction // low = reliable date/intent extraction
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
      action: { type: "string", enum: ["chat", "clarify", "report", "simulate"] },
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
      sim_percent: {
        type: "string",
        description: "For action 'simulate': the pay-raise percent as a number string, e.g. '10'. Empty otherwise.",
      },
      sim_target: {
        type: "string",
        description: "For action 'simulate': the department to raise, e.g. 'Sales'. Empty = whole company.",
      },
      years: {
        type: "array",
        items: { type: "string" },
        description: "For comparing 2+ whole years at company level, the year strings e.g. ['2023','2024','2025']. Empty otherwise.",
      },
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
      "sim_percent",
      "sim_target",
      "years",
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
- "simulate": the user asks a WHAT-IF about giving a pay raise and its effect (e.g. "if I give Sales a 10% raise, what happens to turnover?", "what if we raise pay 5%?"). Set action="simulate", sim_target to the department named (or "" for the whole company), sim_percent to the raise percent found in the message as a number string — "a 10% raise" or "raise pay 10%" both give sim_percent="10" — and period to the year in question (default 2025 if unspecified). Only use action="clarify" if the message gives NO percentage at all.
- "clarify": the user wants a report but a required detail is missing. Ask ONE short, specific question in "reply". Every report needs at least a time period (a year or date range); if it's missing, ask for it. Ask only one question.
- "chat": anything else — greetings, small talk, "what can you do", OR a follow-up question about a report you already produced (e.g. "any other recommended actions?", "why is it high?", "explain that"). Put your answer in "reply".
  - Greetings / capability questions: a short, warm, VARIED reply that invites them to ask for a report.
  - Follow-up questions about the most recent report (given below): answer specifically using that report's data; give additional, DIFFERENT actions or explain the drivers. Never repeat a generic greeting, and do not regenerate the chart.
  - If the user asks HOW a metric is calculated (e.g. "how did you get 7.1%?", "how do you calculate retention?"):
      • If a recent report with a "calc" field is given below, show the ACTUAL worked arithmetic: put calc.latex on its own line wrapped in $$ ... $$, then one short plain-English sentence. Do not invent numbers.
      • If there is NO report yet, explain the GENERAL formula for that metric from the Formula reference below — describe it in words and show it symbolically wrapped in $$ ... $$ (words/symbols only, NO made-up numbers) — then invite them to generate the report to see real figures.
  - Off-topic: politely say you only help with HR reports.

Rules:
- Every "chat" or "clarify" action MUST have a helpful, non-empty "reply". Never return an empty reply.
- Set sim_percent and sim_target to "" for any action other than "simulate".
- Formula reference (use for "how is X calculated" questions): turnover = leavers ÷ average headcount × 100; retention = employees still present at period end ÷ employees at period start × 100; headcount growth = (end − start) ÷ start × 100; average headcount = (start + end) ÷ 2; leave utilization = leave days taken ÷ leave days entitled × 100.
- Dates are YYYY-MM-DD. Treat a bare year (e.g. 2023) as that FULL calendar year: 2023-01-01 to 2023-12-31. Never use a rolling 12-month window unless the user explicitly asks for one.
- Every period covers EXACTLY ONE calendar year: period_from = <year>-01-01 and period_to = the SAME year's -12-31. Never let period_from and period_to fall in different years (same rule for compare_from/compare_to). To cover several years, use the compare fields (2 years) or the "years" array (3+), never a widened single period.
- For a comparison like "A vs B" (exactly two years, e.g. "2022 vs 2023") broken down by a dimension, set period = full calendar year A and compare = full calendar year B, using EXACTLY the two years named. Set compare=true, years=[]. If the user corrects the years, use the corrected ones. Otherwise compare=false and set compare_from/compare_to to "".
- "years" is ONLY for THREE OR MORE years at company level (e.g. "compare turnover 2023, 2024 and 2025", "turnover over the last 3 years"): set group_by="none", put ALL named years in "years" (e.g. ["2023","2024","2025"]), set compare=false, set period to the earliest year, and pick chart_type "bar" or "line". For ONE or TWO years, "years" MUST be []: a single year is a normal report, and two years use the compare fields above — never put 1 or 2 years in the "years" array. If the user names THREE OR MORE years (e.g. "2023, 2024 and 2025"), you MUST put every year in the "years" array and set compare=false — do this even if a previous report used a comparison, and never express the years as widened date ranges.
- Choose chart_type to FIT the question (don't just default to bar):
   • kpi_number — the user wants a single overall figure with no breakdown ("what's our overall turnover?", "total headcount this year"). Use group_by="none".
   • pie — a distribution of a COUNT across categories that adds up to a whole ("headcount distribution across departments", "workforce mix by department"). Do NOT use pie for rates/percentages — use bar for those.
   • bar — comparing a value across categories (by department/grade/gender), or comparing two periods. This is the usual choice for most grouped questions.
   • line — a trend over time (only meaningful when the data has multiple time points, e.g. a monthly trend).
   Always respect an explicit request ("show as a pie", "make it a line"). Otherwise infer the best fit from the wording.
- Metric selection: use average_headcount for questions about how many staff / headcount / workforce size / headcount distribution (it returns the staff count per group). Use headcount_growth only when the user asks about growth or change in headcount.
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

// Multi-year: one value per year at company level (keeps chronological order).
async function computeYears(spec, years) {
  const meta = METRIC_META[spec.metric];
  const sorted = [...new Set(years)].sort();
  const series = [];
  let lastRows = null;
  let lastOverall = 0;
  for (const y of sorted) {
    const rows = await meta.rows("none", `${y}-01-01`, `${y}-12-31`);
    const overall = meta.overall(rows);
    series.push({ label: y, value: overall });
    lastRows = rows;
    lastOverall = overall;
  }
  if (series.length) {
    const pick = series.reduce((a, b) =>
      meta.highlightLowest ? (b.value < a.value ? b : a) : b.value > a.value ? b : a,
    );
    pick.highlight = true; // mark the notable year, but DON'T reorder (stay chronological)
  }

  const earliest = series[0];
  const latest = series[series.length - 1];
  const diff = Math.round((latest.value - earliest.value) * 10) / 10;
  const kpi = {
    label: `${meta.name} (${latest.label})`,
    value: meta.isPercent ? `${latest.value}%` : String(latest.value),
    trend: meta.isPercent
      ? `${diff >= 0 ? "+" : ""}${diff} pts vs ${earliest.label}`
      : `${diff >= 0 ? "+" : ""}${diff} vs ${earliest.label}`,
  };

  return {
    series,
    kpis: [kpi],
    unit: meta.unit,
    y_label: meta.yLabel,
    title: `${meta.name} by year (${sorted.join(", ")})`,
    calc: buildCalc(spec.metric, lastRows, lastOverall),
    facts: {
      metric: spec.metric,
      by_year: series.map((s) => ({ year: s.label, value: s.value })),
      span: `${earliest.label} to ${latest.label}`,
    },
  };
}

// A pay raise is assumed to retain this share of employees who left without ever getting a raise.
const RAISE_EFFECTIVENESS = 0.5;

async function callSimNarrative(facts) {
  const system = `You are an HR analytics assistant presenting a WHAT-IF simulation. Using ONLY the facts provided (never invent numbers):
- narrative: 2 sentences — state the scenario, the projected turnover change, and the extra annual payroll cost. Make clear this is an estimate based on the stated assumption.
- prediction: 1 sentence on the likely outcome, phrased as an estimate.
- advice: 2-3 short, practical next steps (e.g. target the raise at the right group, phase it, monitor results).`;

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

async function simulate(spec) {
  const target = spec.sim_target || "";
  const inp = await metricRepository.simulationInputs(
    target,
    spec.period_from,
    spec.period_to,
  );
  const leavers = Number(inp.leavers);
  const neverRaisedLeavers = Number(inp.never_raised_leavers);
  const exposed = Number(inp.exposed);
  const activeMonthly = Number(inp.active_monthly_salary);
  const raisePct = Number(spec.sim_percent) || 0;

  const currentTurnover = pct(leavers, exposed);
  const retained = Math.round(neverRaisedLeavers * RAISE_EFFECTIVENESS);
  const newLeavers = Math.max(0, leavers - retained);
  const projectedTurnover = pct(newLeavers, exposed);
  const annualCost = Math.round((activeMonthly * 12 * raisePct) / 100);
  const label = target || "company";
  const diff = Math.round((projectedTurnover - currentTurnover) * 10) / 10;

  const series = [
    { label: "Current", value: currentTurnover, highlight: true },
    { label: `After +${raisePct}%`, value: projectedTurnover },
  ];
  const kpis = [
    {
      label: "Projected turnover",
      value: `${projectedTurnover}%`,
      trend: `${diff >= 0 ? "+" : ""}${diff} pts`,
    },
    { label: "Extra annual payroll", value: `$${annualCost.toLocaleString()}` },
  ];

  const facts = {
    scenario: `a ${raisePct}% pay raise for ${label}`,
    period: `${spec.period_from} to ${spec.period_to}`,
    current_turnover_pct: currentTurnover,
    projected_turnover_pct: projectedTurnover,
    leavers,
    never_raised_leavers: neverRaisedLeavers,
    headcount_exposed: exposed,
    employees_retained_estimate: retained,
    extra_annual_payroll_cost: annualCost,
    assumption: `Assume a raise retains ${Math.round(RAISE_EFFECTIVENESS * 100)}% of the ${neverRaisedLeavers} employees who left without ever receiving a raise. This is an estimate, not a guarantee.`,
  };

  return {
    series,
    kpis,
    unit: "%",
    y_label: "Turnover %",
    title: `What-if: ${raisePct}% raise for ${label} (${yr(spec.period_from)})`,
    calc: {
      formula: "extra annual payroll = active monthly salaries × 12 × raise%",
      expr: `$${activeMonthly.toLocaleString()} × 12 × ${raisePct}% = $${annualCost.toLocaleString()}`,
      latex: `\\text{extra cost} = ${activeMonthly} \\times 12 \\times ${raisePct}\\% = ${annualCost}`,
    },
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

    if (p.action === "simulate") {
      if (!p.sim_percent) {
        return {
          type: "message",
          content:
            "What raise percentage should I simulate? For example, 5% or 10%.",
          usage,
          model: PLANNER_MODEL,
        };
      }
      const simSpec = {
        metric: "turnover_rate",
        group_by: "none",
        chart_type: "bar",
        period_from: p.period_from || "2025-01-01",
        period_to: p.period_to || "2025-12-31",
        compare: false,
        compare_from: "",
        compare_to: "",
        sim_percent: p.sim_percent,
        sim_target: p.sim_target || "",
      };
      const sim = await simulate(simSpec);
      const narrativeCompletion = await callSimNarrative(sim.facts);
      addUsage(usage, narrativeCompletion);
      const n = JSON.parse(narrativeCompletion.choices[0].message.content);

      const report_data = {
        spec: simSpec,
        chart_type: "bar",
        unit: sim.unit,
        title: sim.title,
        y_label: sim.y_label,
        badge: "What-if estimate",
        series: sim.series,
        kpis: sim.kpis,
        calc: sim.calc,
        narrative: n.narrative,
        prediction: n.prediction,
        advice: n.advice,
      };
      return {
        type: "report",
        content: n.narrative,
        report_data,
        usage,
        model: NARRATIVE_MODEL,
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

    // Safety net: force every period to a single calendar year (Jan 1 – Dec 31).
    if (spec.period_from) {
      const y = spec.period_from.slice(0, 4);
      spec.period_from = `${y}-01-01`;
      spec.period_to = `${y}-12-31`;
    }
    if (spec.compare && spec.compare_from) {
      const cy = spec.compare_from.slice(0, 4);
      spec.compare_from = `${cy}-01-01`;
      spec.compare_to = `${cy}-12-31`;
    }

    // Multi-year (3+ years) at company level. Two years go through the compare path below.
    if (p.years && p.years.length >= 3 && METRIC_META[spec.metric]) {
      const multi = await computeYears(spec, p.years);
      const narrativeCompletion = await callNarrative(spec.metric, multi.facts);
      addUsage(usage, narrativeCompletion);
      const narrative = JSON.parse(narrativeCompletion.choices[0].message.content);
      const report_data = {
        spec,
        chart_type: spec.chart_type || "bar",
        unit: multi.unit,
        title: multi.title,
        y_label: multi.y_label,
        calc: multi.calc,
        series: multi.series,
        kpis: multi.kpis,
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
    }

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

// For evaluation: run only the planner (no SQL, no narrative) and report latency + tokens.
export async function getPlan(question, ctx = {}) {
  const start = Date.now();
  const completion = await callPlanner(question, ctx);
  const latencyMs = Date.now() - start;
  const plan = JSON.parse(completion.choices[0].message.content);
  return { plan, latencyMs, usage: completion.usage || {} };
}

export default reportService;
