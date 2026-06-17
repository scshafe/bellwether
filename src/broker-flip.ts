import { readFile } from "node:fs/promises";

import type { Pool } from "pg";

import {
  AlpacaLiveAdapter,
  AlpacaPaperAdapter,
  type AlpacaPaperAdapterOptions,
  type BrokerAdapter
} from "./broker.js";
import { isFeatureEnabled } from "./config.js";
import { adminBoundaryRoles, type Role } from "./identity.js";
import { ALPACA_LIVE_BROKER_ACCOUNT_ID, type BrokerCredentialVault } from "./secrets.js";

export type BrokerMode = "paper" | "live";

export type BrokerFlipState = {
  mode: BrokerMode;
  confirmedBy?: string;
  confirmedByRole?: Role;
  secondOperatorSignoff?: string;
  secondOperatorRole?: Role;
  flipVerificationId?: string;
  flipTimestamp?: string;
  auditLogId?: string;
};

export type BrokerSelectorOptions = AlpacaPaperAdapterOptions & {
  env?: NodeJS.ProcessEnv;
  liveCredentialVault?: BrokerCredentialVault;
  liveBrokerAccountId?: string;
};

export type BrokerFlipLogEntry = {
  id: string;
  fromMode: BrokerMode;
  toMode: BrokerMode;
  confirmedBy: string;
  confirmedByRole: Role;
  secondOperator: string;
  secondOperatorRole: Role;
  flipVerificationId: string;
  reason: string;
  createdAt: string;
};

export type AppendBrokerFlipLogInput = Omit<BrokerFlipLogEntry, "id" | "createdAt"> & {
  id?: string;
  createdAt?: string;
};

export interface BrokerFlipLogStore {
  appendFlipChange(input: AppendBrokerFlipLogInput): Promise<BrokerFlipLogEntry>;
}

export class BrokerFlipRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerFlipRefusedError";
  }
}

export function paperFlipState(): BrokerFlipState {
  return { mode: "paper" };
}

export async function createBrokerAdapter(
  credentialVault: BrokerCredentialVault,
  paperAccountId: string,
  flipState: BrokerFlipState = paperFlipState(),
  options: BrokerSelectorOptions = {}
): Promise<BrokerAdapter> {
  const {
    env = process.env,
    liveCredentialVault,
    liveBrokerAccountId = ALPACA_LIVE_BROKER_ACCOUNT_ID,
    ...adapterOptions
  } = options;

  if (flipState.mode !== "live") {
    return new AlpacaPaperAdapter(credentialVault, paperAccountId, adapterOptions);
  }

  const refusal = brokerLiveFlipRefusal(flipState, env, Boolean(liveCredentialVault));

  if (refusal) {
    throw new BrokerFlipRefusedError(refusal);
  }

  if (!liveCredentialVault) {
    throw new BrokerFlipRefusedError("live broker mode refused: live credential vault is unavailable");
  }

  const liveCredential = await liveCredentialVault.getBrokerCredential(liveBrokerAccountId);

  if (!liveCredential) {
    throw new BrokerFlipRefusedError("live broker mode refused: live credentials are not mounted");
  }

  return new AlpacaLiveAdapter(liveCredentialVault, liveBrokerAccountId, {
    ...adapterOptions,
    flipGuard: { affirmed: true }
  });
}

export function brokerLiveFlipRefusal(
  flipState: BrokerFlipState,
  env: NodeJS.ProcessEnv = process.env,
  hasLiveCredentialVault = false
): string | null {
  if (flipState.mode !== "live") {
    return null;
  }

  if (!isFeatureEnabled("broker-mode-live", env)) {
    return "live broker mode refused: feature flag is disabled";
  }

  if (!flipState.confirmedBy?.trim()) {
    return "live broker mode refused: initiating operator is missing";
  }

  if (!flipState.secondOperatorSignoff?.trim()) {
    return "live broker mode refused: second operator sign-off is missing";
  }

  if (flipState.confirmedBy.trim() === flipState.secondOperatorSignoff.trim()) {
    return "live broker mode refused: distinct operators are required";
  }

  if (!flipState.flipVerificationId?.trim()) {
    return "live broker mode refused: verification id is missing";
  }

  if (!flipState.flipTimestamp?.trim()) {
    return "live broker mode refused: verification timestamp is missing";
  }

  if (!isAdminBoundaryRole(flipState.confirmedByRole)) {
    return "live broker mode refused: initiating operator role is not authorized";
  }

  if (!isAdminBoundaryRole(flipState.secondOperatorRole)) {
    return "live broker mode refused: second operator role is not authorized";
  }

  if (!hasLiveCredentialVault) {
    return "live broker mode refused: live credential vault is unavailable";
  }

  return null;
}

export async function ensureBrokerFlipLogSchema(pool: Pool): Promise<void> {
  await pool.query(await readFile(new URL("../db/bootstrap/009_broker_flip_log.sql", import.meta.url), "utf8"));
}

export class PostgresBrokerFlipLogStore implements BrokerFlipLogStore {
  constructor(private readonly pool: Pool) {}

  async appendFlipChange(input: AppendBrokerFlipLogInput): Promise<BrokerFlipLogEntry> {
    validateBrokerFlipLogInput(input);
    const result = await this.pool.query<BrokerFlipLogRow>(
      `
        INSERT INTO broker_flip_log (
          id, from_mode, to_mode, confirmed_by, confirmed_by_role, second_operator,
          second_operator_role, flip_verification_id, reason, created_at
        )
        VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, now()))
        RETURNING id, from_mode, to_mode, confirmed_by, confirmed_by_role, second_operator,
          second_operator_role, flip_verification_id, reason, created_at
      `,
      [
        input.id ?? null,
        input.fromMode,
        input.toMode,
        input.confirmedBy.trim(),
        input.confirmedByRole,
        input.secondOperator.trim(),
        input.secondOperatorRole,
        input.flipVerificationId.trim(),
        input.reason.trim(),
        input.createdAt ?? null
      ]
    );

    return rowToBrokerFlipLogEntry(result.rows[0]);
  }
}

export function validateBrokerFlipLogInput(input: AppendBrokerFlipLogInput): void {
  if (input.fromMode !== "paper" && input.fromMode !== "live") {
    throw new Error("broker flip fromMode must be paper or live");
  }

  if (input.toMode !== "paper" && input.toMode !== "live") {
    throw new Error("broker flip toMode must be paper or live");
  }

  if (!input.confirmedBy.trim()) {
    throw new Error("broker flip initiating operator is required");
  }

  if (!input.secondOperator.trim()) {
    throw new Error("broker flip second operator is required");
  }

  if (input.confirmedBy.trim() === input.secondOperator.trim()) {
    throw new Error("broker flip requires two distinct operators");
  }

  if (!isAdminBoundaryRole(input.confirmedByRole) || !isAdminBoundaryRole(input.secondOperatorRole)) {
    throw new Error("broker flip operators must be admin or manager");
  }

  if (!input.flipVerificationId.trim()) {
    throw new Error("broker flip verification id is required");
  }

  if (!input.reason.trim()) {
    throw new Error("broker flip reason is required");
  }
}

function isAdminBoundaryRole(role: unknown): role is Role {
  return adminBoundaryRoles.includes(role as Role);
}

type BrokerFlipLogRow = {
  id: string;
  from_mode: BrokerMode;
  to_mode: BrokerMode;
  confirmed_by: string;
  confirmed_by_role: Role;
  second_operator: string;
  second_operator_role: Role;
  flip_verification_id: string;
  reason: string;
  created_at: Date | string;
};

function rowToBrokerFlipLogEntry(row: BrokerFlipLogRow): BrokerFlipLogEntry {
  return {
    id: row.id,
    fromMode: row.from_mode,
    toMode: row.to_mode,
    confirmedBy: row.confirmed_by,
    confirmedByRole: row.confirmed_by_role,
    secondOperator: row.second_operator,
    secondOperatorRole: row.second_operator_role,
    flipVerificationId: row.flip_verification_id,
    reason: row.reason,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}
