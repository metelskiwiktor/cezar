import type { AgentModelSettingsStrategy } from './types.ts';

export const agyModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'agy',
  // Agy has no settings file; only an explicit env pin counts as its native model. The runner's
  // own fallback (`DEFAULT_AGY_MODEL`) applies at launch, so it is not reported as a configured
  // default here — that would materialize in `defaultModels` and outrank an auto override (#906).
  async read(_repoRoot, env) {
    const fromEnv = env.CEZ_AGY_MODEL?.trim() || env.AGY_MODEL?.trim();
    return fromEnv ? { model: fromEnv } : {};
  },
};
