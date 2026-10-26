import { pool } from "../config/db.js";

const conversationRepository = {
  async list() {
    const result = await pool.query(
      "SELECT id, title, created_at FROM conversation ORDER BY id DESC",
    );
    return result.rows;
  },

  async create(title = "New chat") {
    const result = await pool.query(
      "INSERT INTO conversation (title) VALUES ($1) RETURNING id, title, created_at",
      [title],
    );
    return result.rows[0];
  },

  async getById(id) {
    const result = await pool.query(
      "SELECT id, title, created_at FROM conversation WHERE id = $1",
      [id],
    );
    return result.rows[0];
  },

  async updateTitle(id, title) {
    await pool.query("UPDATE conversation SET title = $1 WHERE id = $2", [
      title,
      id,
    ]);
  },

  async getMessages(conversationId) {
    const result = await pool.query(
      `SELECT id, role, content, report_data, model,
              prompt_tokens, completion_tokens, total_tokens, created_at
       FROM message
       WHERE conversation_id = $1
       ORDER BY id ASC`,
      [conversationId],
    );
    return result.rows;
  },

  async addMessage(conversationId, role, content, reportData = null, usage = null) {
    const result = await pool.query(
      `INSERT INTO message
         (conversation_id, role, content, report_data, model,
          prompt_tokens, completion_tokens, total_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, role, content, report_data, model,
                 prompt_tokens, completion_tokens, total_tokens, created_at`,
      [
        conversationId,
        role,
        content,
        reportData ? JSON.stringify(reportData) : null,
        usage?.model || null,
        usage?.prompt_tokens ?? null,
        usage?.completion_tokens ?? null,
        usage?.total_tokens ?? null,
      ],
    );
    return result.rows[0];
  },

  // Full report_data of the last assistant report in a conversation (for follow-ups).
  async getLastReport(conversationId) {
    const result = await pool.query(
      `SELECT report_data
       FROM message
       WHERE conversation_id = $1 AND role = 'assistant' AND report_data ? 'spec'
       ORDER BY id DESC
       LIMIT 1`,
      [conversationId],
    );
    return result.rows[0]?.report_data || null;
  },
};

export default conversationRepository;
