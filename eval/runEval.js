import client from "../src/config/openai.js";
import { getPlan } from "../src/services/reportService.js";
import { goldenTests } from "./golden.js";

// A capable model makes a more reliable judge.
const JUDGE_MODEL = "gpt-4o";

const JUDGE_SCHEMA = {
  name: "eval_verdict",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      verdict: { type: "string", enum: ["pass", "fail"] },
      reason: { type: "string" },
    },
    required: ["verdict", "reason"],
  },
};

async function judge(test, plan) {
  const system = `You are a strict evaluator for an AI "planner" that turns an HR user's message into a structured report request.
You are given: the user's question, the expected intent (written by a human), and the planner's JSON output.
Decide if the planner's output correctly satisfies the expected intent.

How this system works (treat these as CORRECT — do NOT penalize them):
- Two-year comparison ("A vs B") uses compare=true with compare_from/compare_to; the "years" array stays EMPTY. This is correct — do not require "years" for a 2-year comparison.
- Three-or-more-year comparison uses the "years" array (with group_by="none", compare=false). This is correct — "compare" is NOT required for multi-year.
- For actions "chat", "clarify", and "simulate", the fields metric/group_by/chart_type/period are placeholders that the system IGNORES. Do NOT fail a case because of their values. For "simulate", only sim_target and sim_percent matter. For "chat"/"clarify", only the action (and that a reply would be given) matters.
- A follow-up that keeps the same period as the previous report is correct.
- A bare year means the full calendar year; date-format or wording differences are fine.

A case FAILS only if: the action is wrong, or (for a report) the metric/grouping/periods/chart genuinely contradict the question, or (for a simulation) sim_target/sim_percent are wrong.
Return verdict "pass" or "fail" and a one-sentence reason.`;

  const user = JSON.stringify({
    question: test.question,
    expected_intent: test.expected,
    planner_output: plan,
  });

  const c = await client.chat.completions.create({
    model: JUDGE_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: JUDGE_SCHEMA },
  });
  return JSON.parse(c.choices[0].message.content);
}

function checkAsserts(assert, plan) {
  if (!assert) return [];
  const fails = [];
  for (const [k, v] of Object.entries(assert)) {
    if (plan[k] !== v) fails.push(`${k}: expected "${v}", got "${plan[k]}"`);
  }
  return fails;
}

async function run() {
  let passed = 0;
  let totalLatency = 0;
  let maxLatency = 0;
  let totalTokens = 0;
  const failures = [];

  console.log(`Running ${goldenTests.length} golden tests...\n`);

  for (const t of goldenTests) {
    const { plan, latencyMs, usage } = await getPlan(t.question, t.ctx || {});
    totalLatency += latencyMs;
    maxLatency = Math.max(maxLatency, latencyMs);
    totalTokens += usage.total_tokens || 0;

    const assertFails = checkAsserts(t.assert, plan);
    const verdict = await judge(t, plan);
    const ok = assertFails.length === 0 && verdict.verdict === "pass";

    if (ok) passed++;
    else failures.push({ test: t, assertFails, verdict, plan });

    console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  ${t.id.padEnd(26)} ${latencyMs}ms`);
  }

  const n = goldenTests.length;
  console.log("\n==================== Summary ====================");
  console.log(`Accuracy:         ${passed}/${n} = ${Math.round((passed / n) * 1000) / 10}%`);
  console.log(`Avg latency:      ${Math.round(totalLatency / n)} ms`);
  console.log(`Max latency:      ${maxLatency} ms`);
  console.log(`Total tokens:     ${totalTokens.toLocaleString()}`);
  console.log(`Judge model:      ${JUDGE_MODEL}`);

  if (failures.length) {
    console.log("\n==================== Failures ===================");
    for (const f of failures) {
      console.log(`\n[${f.test.id}]  "${f.test.question}"`);
      if (f.assertFails.length) console.log(`  asserts: ${f.assertFails.join("; ")}`);
      console.log(`  judge:   ${f.verdict.verdict} — ${f.verdict.reason}`);
      console.log(
        `  plan:    ${JSON.stringify({
          action: f.plan.action,
          metric: f.plan.metric,
          group_by: f.plan.group_by,
          chart_type: f.plan.chart_type,
          period_from: f.plan.period_from,
          period_to: f.plan.period_to,
          compare: f.plan.compare,
          compare_from: f.plan.compare_from,
          years: f.plan.years,
          sim_percent: f.plan.sim_percent,
          sim_target: f.plan.sim_target,
        })}`,
      );
    }
  }
  console.log("");
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
