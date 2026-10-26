import { pool } from "../config/db.js";

// Whitelist of groupable columns — prevents SQL injection on dynamic GROUP BY.
const DIMENSION_COLUMNS = {
  department: "department",
  job_grade: "job_grade",
  gender: "gender",
};

function col(dimension) {
  return DIMENSION_COLUMNS[dimension] || null;
}

const metricRepository = {
  // leavers + exposed headcount per group (or overall)
  async turnoverRows(dimension, from, to) {
    const c = col(dimension);
    const select = `
      count(*) FILTER (WHERE termination_date BETWEEN $1 AND $2) AS leavers,
      count(*) FILTER (WHERE hire_date <= $2 AND (termination_date IS NULL OR termination_date >= $1)) AS exposed`;
    if (!c) {
      const r = await pool.query(`SELECT 'Overall' AS label, ${select} FROM employee`, [from, to]);
      return r.rows;
    }
    const r = await pool.query(
      `SELECT ${c} AS label, ${select} FROM employee GROUP BY ${c} ORDER BY ${c}`,
      [from, to],
    );
    return r.rows;
  },

  // employees active at period start, and how many are still active at period end
  async retentionRows(dimension, from, to) {
    const c = col(dimension);
    const select = `
      count(*) FILTER (WHERE hire_date <= $1 AND (termination_date IS NULL OR termination_date > $1)) AS start_count,
      count(*) FILTER (WHERE hire_date <= $1 AND (termination_date IS NULL OR termination_date > $1)
                        AND (termination_date IS NULL OR termination_date > $2)) AS retained_count`;
    if (!c) {
      const r = await pool.query(`SELECT 'Overall' AS label, ${select} FROM employee`, [from, to]);
      return r.rows;
    }
    const r = await pool.query(
      `SELECT ${c} AS label, ${select} FROM employee GROUP BY ${c} ORDER BY ${c}`,
      [from, to],
    );
    return r.rows;
  },

  // headcount at period start vs period end (used for growth and average)
  async headcountRows(dimension, from, to) {
    const c = col(dimension);
    const select = `
      count(*) FILTER (WHERE hire_date <= $1 AND (termination_date IS NULL OR termination_date > $1)) AS start_count,
      count(*) FILTER (WHERE hire_date <= $2 AND (termination_date IS NULL OR termination_date > $2)) AS end_count`;
    if (!c) {
      const r = await pool.query(`SELECT 'Overall' AS label, ${select} FROM employee`, [from, to]);
      return r.rows;
    }
    const r = await pool.query(
      `SELECT ${c} AS label, ${select} FROM employee GROUP BY ${c} ORDER BY ${c}`,
      [from, to],
    );
    return r.rows;
  },

  // annual-leave days taken vs entitled per group (separate table, same DB)
  async leaveRows(dimension, from, to) {
    const c = col(dimension);
    const r = await pool.query(
      `WITH active AS (
         SELECT id, ${c ? `${c},` : ""} annual_leave_entitlement AS ent
         FROM employee
         WHERE hire_date <= $2 AND (termination_date IS NULL OR termination_date >= $1)
       ),
       taken AS (
         SELECT employee_id, sum(days) AS days
         FROM leave_record
         WHERE leave_type = 'Annual' AND start_date BETWEEN $1 AND $2
         GROUP BY employee_id
       )
       SELECT ${c ? `e.${c}` : `'Overall'`} AS label,
              COALESCE(sum(t.days), 0) AS taken_days,
              sum(e.ent) AS entitled_days
       FROM active e
       LEFT JOIN taken t ON t.employee_id = e.id
       ${c ? `GROUP BY e.${c} ORDER BY e.${c}` : ""}`,
      [from, to],
    );
    return r.rows;
  },

  // turnover drivers for a grounded narrative
  async leaverDrivers(from, to) {
    const r = await pool.query(
      `SELECT count(*) AS total_leavers,
              count(*) FILTER (WHERE last_salary_change_date = hire_date) AS never_raised,
              COALESCE(round(avg((termination_date - hire_date) / 30.0)::numeric, 1), 0) AS avg_tenure_months
       FROM employee
       WHERE termination_date BETWEEN $1 AND $2`,
      [from, to],
    );
    return r.rows[0];
  },
};

export default metricRepository;
