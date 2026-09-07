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
export interface ParsedArtifact {
  first_id: number | null;
  head: number | null;
  sha256: string | null;
}
export const BASE: string;
export const PAGE: number;
export function fetchWindow(firstId: number, head: number, base?: string, fetchImpl?: typeof fetch): Promise<ChainEvent[]>;
export function findSubmissionEventId(submissionId: number, base?: string, fetchImpl?: typeof fetch): Promise<number | null>;
export function replayLedger(events: ChainEvent[], head?: number): Ledger;
export function canonicalJson(value: unknown): string;
export function isoSeconds(ms: number): string;
export function eventRecord(e: ChainEvent): Record<string, unknown>;
export function windowText(events: ChainEvent[]): string;
export function sha256Hex(text: string): Promise<string>;
export function parseArtifact(text: string): ParsedArtifact;
