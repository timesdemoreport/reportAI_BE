import healthRepository from "../repositories/healthRepository.js";

const healthService = {
  async check() {
    const { now } = await healthRepository.ping();
    return { status: "ok", db: "connected", time: now };
  },
};

export default healthService;
