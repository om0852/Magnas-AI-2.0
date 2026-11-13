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
export { checkAccess, type Access, type AccessConfig, type AccessRequest } from './dashboard.js';
export {
  claimDevice,
  deviceByToken,
  DEVICE_PAIR_MINUTES,
  keyCode,
  listDevices,
  removeDevice,
  setApprover,
  startDevicePairing,
  type Device,
} from './remote/devices.js';
export { findXtraosCore, xtraosCaller, type XtraosCall } from './xtraos.js';
export { loadRelay, relayAppUrl, relayInvite, removeRelayDevice, type RelayConfig, type RelayDevice } from './remote/relay-pc.js';
export { controlsFrom, type Control } from './remote/controls.js';
export { dpapiProtector } from './secrets.js';
export type { Progress, ProgressKind } from './brain/progress.js';
export { answerQuestion, listTasks, type Task, type TaskStatus } from './tasks/tasks.js';
export { trackedAsk } from './tasks/track.js';
export { chatSend, deleteChat, getChat, listChats, renameChat, type Chat, type ChatMessage, type ChatSummary } from './chats/chats.js';
