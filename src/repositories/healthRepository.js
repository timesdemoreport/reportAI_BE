import { pool } from "../config/db.js";

const healthRepository = {
  async ping() {
    const result = await pool.query("SELECT NOW() AS now");
    return result.rows[0];
  },
};

export default healthRepository;
