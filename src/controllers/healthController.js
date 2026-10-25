import healthService from "../services/healthService.js";

const healthController = {
  async check(req, res) {
    try {
      const result = await healthService.check();
      res.json(result);
    } catch (err) {
      console.error("Health check failed:", err);
      res.status(500).json({ status: "error", error: err.message });
    }
  },
};

export default healthController;
