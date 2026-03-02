/**
 * Workers module — generic Worker lifecycle management.
 *
 * Re-exports the WorkerAdapter and related types for use by
 * higher-level adapters (ProjectAdapter, SubAgentManager).
 */
export {
  WorkerAdapter,
  makeWorkerKey,
  type WorkerKey,
  type WorkerOutbound,
  type WorkerInbound,
  type OnNotifyCallback,
  type OnWorkerCloseCallback,
} from "./worker-adapter.ts";
