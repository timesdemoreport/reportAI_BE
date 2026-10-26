import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import healthRoutes from "./routes/healthRoutes.js";
import conversationRoutes from "./routes/conversationRoutes.js";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.use("/api/health", healthRoutes);
app.use("/api/conversations", conversationRoutes);

app.get("/", (req, res) => res.send("🚀 ReportAI backend is running!"));

app.listen(PORT, () =>
  console.log(`🚀 Backend running on http://localhost:${PORT}`),
);
