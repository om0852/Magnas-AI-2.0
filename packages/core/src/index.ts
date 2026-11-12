/** The public entry of @magnus/core, for the dashboard (apps/web). The CLI is `cli.ts`. */
export {
  checkDashboardRequest,
  dashboardState,
  setClientMode,
  type DashboardRefusal,
  type DashboardRequest,
  type DashboardServer,
  type DashboardState,
  type DashboardTool,
} from './dashboard.js';
export { ask, brainConfig, logAsk, realBrains, type AskResult, type BrainConfig } from './brain/ask.js';
export { BRAIN_NAMES } from './brain/runners.js';
export { envFromProcess } from './registry.js';
export { depsWithCli, sync, type SyncDeps, type SyncOptions, type SyncResult } from './sync.js';
export { MagnusError, type Action, type Env, type Op } from './types.js';
