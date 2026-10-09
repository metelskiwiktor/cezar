import type { AgentModelSettingsStrategy } from './types.ts';

export const agyModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'agy',
  async read(_repoRoot, env) {
    const fromEnv = env.CEZ_AGY_MODEL?.trim() || env.AGY_MODEL?.trim();
    return { model: fromEnv || 'gemini-3.8-flash-high' };
  },
};
