import express from "express";
import conversationController from "../controllers/conversationController.js";

const router = express.Router();

router.get("/", conversationController.list);
router.post("/", conversationController.create);
router.get("/:id/messages", conversationController.getMessages);
router.post("/:id/messages", conversationController.sendMessage);

export default router;
