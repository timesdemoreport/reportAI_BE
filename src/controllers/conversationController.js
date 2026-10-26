import conversationService from "../services/conversationService.js";

const conversationController = {
  async list(req, res) {
    try {
      const result = await conversationService.list();
      res.json(result);
    } catch (err) {
      console.error("Error listing conversations:", err);
      res.status(500).json({ error: err.message || "Server error" });
    }
  },

  async create(req, res) {
    try {
      const result = await conversationService.create();
      res.json(result);
    } catch (err) {
      console.error("Error creating conversation:", err);
      res.status(500).json({ error: err.message || "Server error" });
    }
  },

  async getMessages(req, res) {
    try {
      const result = await conversationService.getMessages(req.params.id);
      res.json(result);
    } catch (err) {
      console.error("Error getting messages:", err);
      res.status(500).json({ error: err.message || "Server error" });
    }
  },

  async sendMessage(req, res) {
    try {
      const { content } = req.body;
      if (!content || !content.trim()) {
        return res.status(400).json({ error: "content is required" });
      }
      const result = await conversationService.sendMessage(
        req.params.id,
        content.trim(),
      );
      res.json(result);
    } catch (err) {
      console.error("Error sending message:", err);
      res.status(500).json({ error: err.message || "Server error" });
    }
  },
};

export default conversationController;
