import conversationRepository from "../repositories/conversationRepository.js";
import reportService from "./reportService.js";

const conversationService = {
  async list() {
    return conversationRepository.list();
  },

  async create() {
    return conversationRepository.create("New chat");
  },

  async getMessages(conversationId) {
    return conversationRepository.getMessages(conversationId);
  },

  async sendMessage(conversationId, content) {
    // Context for the AI: last report + recent history (before storing the new question)
    const previousReport = await conversationRepository.getLastReport(conversationId);
    const previousSpec = previousReport?.spec || null;
    const prior = await conversationRepository.getMessages(conversationId);
    const history = prior.slice(-10).map((m) => ({ role: m.role, content: m.content }));

    // Store the user's question
    const userMessage = await conversationRepository.addMessage(
      conversationId,
      "user",
      content,
      null,
      null,
    );

    // Run the AI: it decides chat vs clarify vs report (and returns token usage)
    let assistantContent;
    let reportData = null;
    let usage = null;
    try {
      const result = await reportService.handleMessage(content, {
        previousSpec,
        previousReport,
        history,
      });
      assistantContent = result.content;
      reportData = result.report_data || null;
      usage = { model: result.model, ...result.usage };
    } catch (err) {
      console.error("Report generation failed:", err);
      assistantContent =
        "Sorry, I couldn't build that report. Please try rephrasing your request.";
    }

    const assistantMessage = await conversationRepository.addMessage(
      conversationId,
      "assistant",
      assistantContent,
      reportData,
      usage,
    );

    // Auto-title the chat from the first actual report (not a greeting)
    const conversation = await conversationRepository.getById(conversationId);
    if (conversation && conversation.title === "New chat" && reportData?.title) {
      await conversationRepository.updateTitle(conversationId, reportData.title);
    }

    return { userMessage, assistantMessage };
  },
};

export default conversationService;
