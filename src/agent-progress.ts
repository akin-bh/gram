export type RunProgress = { type: string; at: string; method?: string; path?: string; status?: number; action_type?: string };
const progressTypes = new Set(['agent.started', 'agent.session', 'agent.message', 'agent.tool.request', 'agent.tool.response', 'agent.tool.failure', 'agent.capability.denied', 'agent.completed', 'agent.failed', 'agent.interrupted']);
const toolTypes = new Set(['agent.tool.request', 'agent.tool.response', 'agent.tool.failure']);
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
function safePath(value: unknown) {
  if (typeof value !== 'string') return;
  const path = value.split(/[?#]/, 1)[0];
  if (path.length > 512 || /[\u0000-\u0020\u007f\\]|%(?:00|0a|0d|5c)|sk-(?:ant|proj)-/i.test(path)) return;
  if (!/^\/api\/worlds\/[A-Za-z0-9_-]{1,200}\/(?:context|records|actions|work(?:\/(?:briefing|history|precedents|items\/[A-Za-z0-9_.%-]+))?|attachment-content\/[A-Za-z0-9_.%-]+\/[A-Za-z0-9_.%-]+)$/.test(path)) return;
  return path;
}

/** A current observation, never a copy of a tool payload or model response. */
export function compactRunProgress(event: unknown, at: string): RunProgress | undefined {
  if (!event || typeof event !== 'object' || Array.isArray(event) || !timestamp(at)) return;
  const value = event as Record<string, any>;
  if (!progressTypes.has(value.type)) return;
  const progress: RunProgress = { type: value.type, at };
  if (toolTypes.has(value.type)) {
    if (value.method === 'GET' || value.method === 'POST') progress.method = value.method;
    const path = safePath(value.path); if (path) progress.path = path;
    if (Number.isInteger(value.status) && value.status >= 100 && value.status <= 599) progress.status = value.status;
    if (value.type === 'agent.tool.request' && value.method === 'POST' && (path?.endsWith('/actions') || path?.endsWith('/work')) && typeof value.body?.type === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value.body.type)) progress.action_type = value.body.type;
  }
  return progress;
}

export function withRunProgress(run: Record<string, any>, event: unknown, at: string) {
  const progress = compactRunProgress(event, at);
  return progress ? { ...run, progress } : run;
}

export function finishRun(run: Record<string, any>, status: 'completed' | 'failed' | 'cancelled' | 'interrupted', at: string, result: Record<string, any> = {}): Record<string, any> {
  const type = status === 'completed' ? 'agent.completed' : status === 'interrupted' ? 'agent.interrupted' : 'agent.failed';
  const recorded = run.progress?.type === type && timestamp(run.progress.at) ? compactRunProgress(run.progress, run.progress.at) : undefined;
  return { ...run, ...result, status, finished_at: at, progress: recorded ?? compactRunProgress({ type }, at) };
}
