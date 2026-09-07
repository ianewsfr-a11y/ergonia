// Types for chain.mjs so the vitest suite (strict TypeScript) can import it.
export interface ChainEvent {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
  created_at: number;
}
export interface Ledger {
  head: number;
  total: number;
  circulating: number;
  escrow: number;
  open_tasks: number[];
  balances: Record<string, number>;
}
export const BASE: string;
export const PAGE: number;
export function fetchWindow(firstId: number, head: number, base?: string, fetchImpl?: typeof fetch): Promise<ChainEvent[]>;
export function replayLedger(events: ChainEvent[], head?: number): Ledger;
