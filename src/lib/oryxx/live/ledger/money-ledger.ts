// ORYXX — Live Marketplace Double-Entry Money Ledger
//
// A self-contained, in-memory double-entry ledger for the live marketplace.
// Every monetary movement is recorded as a pair of LedgerEntry objects:
//   - one DEBIT  (decreases one account's balance)
//   - one CREDIT (increases another account's balance)
// The two entries are linked via `pairedEntryId` so the audit trail is
// always balanced: every debit has exactly one matching credit, and vice
// versa. The ledger can never create or destroy money.
//
// Money is ALWAYS integer minor units (cents). No floating-point money.
// No LLM ever sets an amount — all amounts come from explicit method calls
// and are recorded verbatim.
//
// Idempotency: every postEntry() call carries a caller-provided
// `idempotencyKey`. If a key is replayed (within the same environment),
// the original entry pair is returned WITHOUT creating a new pair. This
// makes the ledger safe to call from retry-prone upstream code (HTTP
// retries, at-least-once message handlers, etc.).
//
// Environment isolation: every account is created with an explicit
// Environment (FIXTURE | SANDBOX | LIVE | REPLAY). Every postEntry() call
// also takes an environment. The ledger refuses to post an entry if (a)
// the entry's environment does not match both accounts' environment, or
// (b) the two accounts are in different environments. SANDBOX money can
// NEVER touch LIVE accounts.
//
// Provenance: every account and entry carries an environment tag, so the
// audit trail can be sliced by environment at any time.

import type {
  AccountType,
  Environment,
  LedgerEntry,
  MoneyAccount,
  PaymentIntent,
  Settlement,
} from "../types";

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

export const LEDGER_VERSION = "oryxx-ledger-v1.0.0";

/** The platform's owner ID for system-level accounts (escrow, revenue). */
export const ORYXX_PLATFORM_OWNER_ID = "oryxx-platform";

// ═══════════════════════════════════════════════════════════════════════
// INTERNAL ACCOUNT RECORD
// ═══════════════════════════════════════════════════════════════════════

/**
 * Internal account record. Extends the public MoneyAccount with an in-memory
 * list of entries posted against it (in chronological order). The entries
 * are NOT part of the public MoneyAccount interface — they're an internal
 * index to make getAccountHistory() O(1) instead of O(n) over all entries.
 */
interface AccountRecord {
  account: MoneyAccount;
  entries: LedgerEntry[];
}

// ═══════════════════════════════════════════════════════════════════════
// ID GENERATION
// ═══════════════════════════════════════════════════════════════════════

let accountCounter = 0;
let entryCounter = 0;
let intentCounter = 0;
let settlementCounter = 0;

/** Generate a unique Account ID, prefixed by account type. */
function nextAccountId(type: AccountType, ownerId: string): string {
  accountCounter += 1;
  // Use a short hash of the owner ID to make accounts more recognizable in logs.
  const ownerTag = ownerId.substring(0, 12).replace(/[^a-zA-Z0-9]/g, "");
  return `ACC-${type}-${ownerTag}-${accountCounter}`;
}

/** Generate a unique LedgerEntry ID, prefixed by entry type. */
function nextEntryId(type: "DEBIT" | "CREDIT"): string {
  entryCounter += 1;
  return `ENT-${type}-${entryCounter}`;
}

/** Generate a unique PaymentIntent ID. */
function nextIntentId(): string {
  intentCounter += 1;
  return `PMT-${intentCounter}`;
}

/** Generate a unique Settlement ID. */
function nextSettlementId(): string {
  settlementCounter += 1;
  return `STL-${settlementCounter}`;
}

// ═══════════════════════════════════════════════════════════════════════
// MONEY LEDGER
// ═══════════════════════════════════════════════════════════════════════

/**
 * A double-entry money ledger. Holds accounts in memory, indexed by account
 * ID. Every monetary movement is recorded as a balanced (debit, credit)
 * entry pair linked via pairedEntryId.
 *
 * The ledger is intentionally NOT thread-safe — it relies on the JavaScript
 * single-threaded event loop. For multi-process deployments, callers should
 * shard by environment (one ledger per environment per process) and use an
 * external coordination layer (e.g. a database with row-level locking) for
 * cross-process consistency.
 *
 * Usage:
 *   const ledger = new MoneyLedger();
 *   const customer = ledger.createAccount("user-1", "customer", "USD", "SANDBOX");
 *   const escrow   = ledger.createAccount(ORYXX_PLATFORM_OWNER_ID, "escrow", "USD", "SANDBOX");
 *   const { debitEntry, creditEntry } = ledger.postEntry(
 *     customer.id, escrow.id, 1500, "USD",
 *     "Authorize payment for demand D1",
 *     "demand", "D1",
 *     "auth-D1-v1", "SANDBOX",
 *   );
 */
export class MoneyLedger {
  /** All accounts, indexed by ID. */
  private readonly accounts = new Map<string, AccountRecord>();

  /**
   * Idempotency index: maps idempotencyKey → { debitEntry, creditEntry }.
   * Keyed by `${environment}:${idempotencyKey}` so the same key can be reused
   * across environments without collision (though in practice callers should
   * use environment-unique keys).
   */
  private readonly idempotencyIndex = new Map<
    string,
    { debitEntry: LedgerEntry; creditEntry: LedgerEntry }
  >();

  /** All settlements, indexed by ID. */
  private readonly settlements = new Map<string, Settlement>();

  // ─────────────────────────────────────────────────────────────────────
  // ACCOUNTS
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Create a new account with balance 0.
   *
   * @param ownerId      The owner: a user ID (for "customer"), a provider ID
   *                     (for "supplier"), or ORYXX_PLATFORM_OWNER_ID (for
   *                     "escrow", "platform-revenue", "platform-sandbox").
   * @param type         Account type (drives account semantics).
   * @param currency     ISO 4217 currency code ("USD", "EUR", etc.).
   * @param environment  FIXTURE | SANDBOX | LIVE | REPLAY. The account is
   *                     forever bound to this environment — it cannot be
   *                     changed, and entries from other environments will
   *                     be refused.
   * @returns            A new MoneyAccount with balance 0.
   */
  createAccount(
    ownerId: string,
    type: AccountType,
    currency: string,
    environment: Environment,
  ): MoneyAccount {
    if (!ownerId) {
      throw new Error("Account ownerId is required.");
    }
    if (!currency || currency.length !== 3) {
      throw new Error(`Currency must be a 3-letter ISO 4217 code; got "${currency}".`);
    }

    const account: MoneyAccount = {
      id: nextAccountId(type, ownerId),
      ownerId,
      type,
      currency: currency.toUpperCase(),
      balance: 0,
      environment,
      frozen: false,
      createdAt: new Date().toISOString(),
    };

    this.accounts.set(account.id, { account, entries: [] });
    return account;
  }

  /**
   * Look up an account by ID. Throws if not found.
   */
  getAccount(accountId: string): MoneyAccount {
    const rec = this.accounts.get(accountId);
    if (!rec) {
      throw new Error(`Account ${accountId} not found.`);
    }
    return rec.account;
  }

  /**
   * Freeze or unfreeze an account. Frozen accounts cannot be debited (e.g. a
   * customer account under fraud review). Credits are still allowed (so the
   * account can receive refunds).
   */
  setFrozen(accountId: string, frozen: boolean): MoneyAccount {
    const rec = this.accounts.get(accountId);
    if (!rec) {
      throw new Error(`Account ${accountId} not found.`);
    }
    const account = { ...rec.account, frozen };
    rec.account = account;
    return account;
  }

  // ─────────────────────────────────────────────────────────────────────
  // DOUBLE-ENTRY POSTING
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Post a balanced (debit, credit) entry pair to the ledger.
   *
   *   - DEBIT decreases debitAccount's balance by `amount`.
   *   - CREDIT increases creditAccount's balance by `amount`.
   *   - The two entries are linked via pairedEntryId.
   *   - Both entries share the same idempotencyKey, currency, referenceType,
   *     referenceId, environment, description, and timestamp.
   *
   * Environment isolation: the entry's `environment` must match both
   * accounts' environment. This is the hard boundary between SANDBOX and
   * LIVE money — a SANDBOX entry can never touch a LIVE account, even if
   * the account IDs were somehow leaked across environments.
   *
   * Idempotency: if `idempotencyKey` has already been used in this
   * environment, the original entry pair is returned unchanged. No new
   * entries are created, and no balances are moved.
   *
   * @param debitAccountId     Account to DEBIT (balance decreases).
   * @param creditAccountId    Account to CREDIT (balance increases).
   * @param amount             Positive integer minor units.
   * @param currency           ISO 4217 code (must match both accounts).
   * @param description        Human-readable description for audit.
   * @param referenceType      The kind of object this entry refers to.
   * @param referenceId        The ID of the referenced object.
   * @param idempotencyKey     Caller-provided unique key (per environment).
   * @param environment        The environment of this entry.
   * @returns                  The pair of created (or replayed) entries.
   */
  postEntry(
    debitAccountId: string,
    creditAccountId: string,
    amount: number,
    currency: string,
    description: string,
    referenceType: LedgerEntry["referenceType"],
    referenceId: string,
    idempotencyKey: string,
    environment: Environment,
  ): { debitEntry: LedgerEntry; creditEntry: LedgerEntry } {
    // ── Idempotency check ────────────────────────────────────────────
    // If this key has been used before in this environment, return the
    // existing entry pair unchanged. No balances move. This is what makes
    // the ledger safe under retry.
    const idemKey = `${environment}:${idempotencyKey}`;
    const existing = this.idempotencyIndex.get(idemKey);
    if (existing) {
      return existing;
    }

    // ── Validation ───────────────────────────────────────────────────
    if (debitAccountId === creditAccountId) {
      throw new Error(
        `Cannot post entry with debitAccount == creditAccount (${debitAccountId}).`,
      );
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error(
        `Amount must be a positive integer minor unit; got ${amount}.`,
      );
    }

    const debitRec = this.accounts.get(debitAccountId);
    const creditRec = this.accounts.get(creditAccountId);
    if (!debitRec) {
      throw new Error(`Debit account ${debitAccountId} not found.`);
    }
    if (!creditRec) {
      throw new Error(`Credit account ${creditAccountId} not found.`);
    }

    // Environment isolation: entry environment must match both accounts.
    if (debitRec.account.environment !== environment) {
      throw new Error(
        `Environment isolation violated: debit account ${debitAccountId} ` +
          `is in ${debitRec.account.environment}, but entry is for ${environment}.`,
      );
    }
    if (creditRec.account.environment !== environment) {
      throw new Error(
        `Environment isolation violated: credit account ${creditAccountId} ` +
          `is in ${creditRec.account.environment}, but entry is for ${environment}.`,
      );
    }
    if (debitRec.account.environment !== creditRec.account.environment) {
      throw new Error(
        `Environment isolation violated: debit account ${debitAccountId} ` +
          `(${debitRec.account.environment}) and credit account ${creditAccountId} ` +
          `(${creditRec.account.environment}) are in different environments.`,
      );
    }

    // Currency must match across both accounts and the entry.
    const cur = currency.toUpperCase();
    if (debitRec.account.currency !== cur) {
      throw new Error(
        `Currency mismatch: debit account ${debitAccountId} is ` +
          `${debitRec.account.currency}, entry is ${cur}.`,
      );
    }
    if (creditRec.account.currency !== cur) {
      throw new Error(
        `Currency mismatch: credit account ${creditAccountId} is ` +
          `${creditRec.account.currency}, entry is ${cur}.`,
      );
    }

    // Frozen accounts cannot be debited (credits are still allowed — e.g.
    // refunds to a frozen customer account).
    if (debitRec.account.frozen) {
      throw new Error(
        `Debit account ${debitAccountId} is frozen; cannot debit.`,
      );
    }

    // ── Sufficient funds check ───────────────────────────────────────
    // The ledger is conservative: it refuses to let a balance go negative
    // for customer and escrow accounts. Supplier and platform-revenue
    // accounts CAN go negative (they represent payable / receivable
    // positions), but customer and escrow accounts represent held cash and
    // must never be overdrawn.
    if (
      (debitRec.account.type === "customer" ||
        debitRec.account.type === "escrow") &&
      debitRec.account.balance < amount
    ) {
      throw new Error(
        `Insufficient funds: debit account ${debitAccountId} ` +
          `(${debitRec.account.type}) has balance ${debitRec.account.balance}, ` +
          `cannot debit ${amount}.`,
      );
    }

    // ── Create the entry pair ────────────────────────────────────────
    const timestamp = new Date().toISOString();
    const debitId = nextEntryId("DEBIT");
    const creditId = nextEntryId("CREDIT");

    const debitEntry: LedgerEntry = {
      id: debitId,
      accountId: debitAccountId,
      type: "DEBIT",
      amount,
      currency: cur,
      description,
      referenceType,
      referenceId,
      idempotencyKey,
      pairedEntryId: creditId,
      environment,
      timestamp,
    };

    const creditEntry: LedgerEntry = {
      id: creditId,
      accountId: creditAccountId,
      type: "CREDIT",
      amount,
      currency: cur,
      description,
      referenceType,
      referenceId,
      idempotencyKey,
      pairedEntryId: debitId,
      environment,
      timestamp,
    };

    // ── Apply balances + record entries ──────────────────────────────
    const newDebitAccount: MoneyAccount = {
      ...debitRec.account,
      balance: debitRec.account.balance - amount,
    };
    const newCreditAccount: MoneyAccount = {
      ...creditRec.account,
      balance: creditRec.account.balance + amount,
    };
    debitRec.account = newDebitAccount;
    debitRec.entries.push(debitEntry);
    creditRec.account = newCreditAccount;
    creditRec.entries.push(creditEntry);

    // ── Index idempotency ────────────────────────────────────────────
    this.idempotencyIndex.set(idemKey, { debitEntry, creditEntry });

    return { debitEntry, creditEntry };
  }

  // ─────────────────────────────────────────────────────────────────────
  // QUERIES
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Get the current balance of an account, in integer minor units.
   */
  getBalance(accountId: string): number {
    return this.getAccount(accountId).balance;
  }

  /**
   * Get the full entry history for an account, in chronological order.
   * Useful for statement generation and audit.
   */
  getAccountHistory(accountId: string): LedgerEntry[] {
    const rec = this.accounts.get(accountId);
    if (!rec) {
      throw new Error(`Account ${accountId} not found.`);
    }
    // Return a defensive copy — callers must not mutate the internal array.
    return [...rec.entries];
  }

  // ─────────────────────────────────────────────────────────────────────
  // PAYMENT FLOW
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Authorize a payment: DEBIT customer, CREDIT escrow. Moves `userPrice`
   * from the customer's account into the platform's escrow account,
   * holding it there until capture or refund.
   *
   * The intent MUST be in state PENDING. On success it transitions to
   * AUTHORIZED and authorizationId is set.
   *
   * Account lookup: the customer account is found by scanning accounts of
   * type "customer" owned by `intent.customerId` in `intent.environment`.
   * The escrow account is the (single) "escrow" account owned by the
   * platform in the same environment. If either doesn't exist, this
   * method throws — callers must pre-create the accounts (typically at
   * user-onboarding time).
   *
   * Idempotency: the entry pair is keyed by `intent.idempotencyKey +
   * ":authorize"`. Replaying authorizePayment with the same intent
   * returns the same AUTHORIZED intent without moving money again.
   *
   * @param intent  PENDING PaymentIntent to authorize.
   * @returns       AUTHORIZED PaymentIntent with authorizationId set.
   */
  authorizePayment(intent: PaymentIntent): PaymentIntent {
    if (intent.status !== "PENDING") {
      throw new Error(
        `Cannot authorize intent ${intent.id}: status is ${intent.status} (must be PENDING).`,
      );
    }

    const customerAccount = this.findAccount(
      "customer",
      intent.customerId,
      intent.currency,
      intent.environment,
    );
    const escrowAccount = this.findAccount(
      "escrow",
      ORYXX_PLATFORM_OWNER_ID,
      intent.currency,
      intent.environment,
    );

    const { debitEntry } = this.postEntry(
      customerAccount.id,
      escrowAccount.id,
      intent.userPrice,
      intent.currency,
      `Authorize payment for demand ${intent.demandId}` +
        (intent.agreementId ? ` (agreement ${intent.agreementId})` : ""),
      "payment-intent",
      intent.id,
      `${intent.idempotencyKey}:authorize`,
      intent.environment,
    );

    return {
      ...intent,
      status: "AUTHORIZED",
      authorizationId: debitEntry.id,
    };
  }

  /**
   * Capture an authorized payment: DEBIT escrow, CREDIT supplier
   * (compensation) + CREDIT platform-revenue (fee).
   *
   * This posts TWO entry pairs:
   *   1. Escrow → Supplier (supplierCompensation)
   *   2. Escrow → Platform-revenue (platformFee)
   *
   * The intent MUST be in state AUTHORIZED. On success it transitions to
   * CAPTURED and captureId is set.
   *
   * @param intent  AUTHORIZED PaymentIntent to capture.
   * @returns       CAPTURED PaymentIntent with captureId set.
   */
  capturePayment(intent: PaymentIntent): PaymentIntent {
    if (intent.status !== "AUTHORIZED") {
      throw new Error(
        `Cannot capture intent ${intent.id}: status is ${intent.status} (must be AUTHORIZED).`,
      );
    }

    const escrowAccount = this.findAccount(
      "escrow",
      ORYXX_PLATFORM_OWNER_ID,
      intent.currency,
      intent.environment,
    );
    const supplierAccount = this.findAccount(
      "supplier",
      intent.supplierId,
      intent.currency,
      intent.environment,
    );
    const revenueAccount = this.findAccount(
      "platform-revenue",
      ORYXX_PLATFORM_OWNER_ID,
      intent.currency,
      intent.environment,
    );

    // Sanity check: compensation + fee must equal userPrice (the amount
    // currently held in escrow on behalf of this intent).
    if (intent.supplierCompensation + intent.platformFee !== intent.userPrice) {
      throw new Error(
        `Cannot capture intent ${intent.id}: supplierCompensation (${intent.supplierCompensation}) ` +
          `+ platformFee (${intent.platformFee}) != userPrice (${intent.userPrice}).`,
      );
    }

    // Pair 1: Escrow → Supplier (compensation).
    const { debitEntry: supplierDebit } = this.postEntry(
      escrowAccount.id,
      supplierAccount.id,
      intent.supplierCompensation,
      intent.currency,
      `Capture payment for demand ${intent.demandId}: supplier compensation`,
      "payment-intent",
      intent.id,
      `${intent.idempotencyKey}:capture:supplier`,
      intent.environment,
    );

    // Pair 2: Escrow → Platform-revenue (fee). Only posted if there's a fee.
    let feeEntryId: string | undefined;
    if (intent.platformFee > 0) {
      const { debitEntry: feeDebit } = this.postEntry(
        escrowAccount.id,
        revenueAccount.id,
        intent.platformFee,
        intent.currency,
        `Capture payment for demand ${intent.demandId}: platform fee`,
        "payment-intent",
        intent.id,
        `${intent.idempotencyKey}:capture:fee`,
        intent.environment,
      );
      feeEntryId = feeDebit.id;
    }

    return {
      ...intent,
      status: "CAPTURED",
      captureId: supplierDebit.id + (feeEntryId ? `+${feeEntryId}` : ""),
      capturedAt: new Date().toISOString(),
    };
  }

  /**
   * Refund an authorized (but not captured) payment: DEBIT escrow,
   * CREDIT customer. Releases the held funds back to the customer.
   *
   * The intent MUST be in state AUTHORIZED (refunding a CAPTURED payment
   * requires a different flow — debiting the supplier/platform-revenue
   * accounts, which is out of scope for this method).
   *
   * @param intent  AUTHORIZED PaymentIntent to refund.
   * @returns       REFUNDED PaymentIntent with refundId set.
   */
  refundPayment(intent: PaymentIntent): PaymentIntent {
    if (intent.status !== "AUTHORIZED") {
      throw new Error(
        `Cannot refund intent ${intent.id}: status is ${intent.status} ` +
          `(must be AUTHORIZED; refund-after-capture is not supported by this method).`,
      );
    }

    const escrowAccount = this.findAccount(
      "escrow",
      ORYXX_PLATFORM_OWNER_ID,
      intent.currency,
      intent.environment,
    );
    const customerAccount = this.findAccount(
      "customer",
      intent.customerId,
      intent.currency,
      intent.environment,
    );

    const { debitEntry } = this.postEntry(
      escrowAccount.id,
      customerAccount.id,
      intent.userPrice,
      intent.currency,
      `Refund payment for demand ${intent.demandId}`,
      "refund",
      intent.id,
      `${intent.idempotencyKey}:refund`,
      intent.environment,
    );

    return {
      ...intent,
      status: "REFUNDED",
      refundId: debitEntry.id,
    };
  }

  /**
   * Settle an execution: record a Settlement against the supplier. This is
   * a bookkeeping operation — the actual money was already moved during
   * capturePayment (supplier compensation was credited to the supplier
   * account). This method records that the supplier's external disbursement
   * (e.g. ACH transfer, payroll) has been initiated against the captured
   * amount.
   *
   * The Settlement is created in state SETTLED (we assume the disbursement
   * succeeds; if it fails, callers can mark it FAILED via markSettlementFailed).
   *
   * Idempotency: the Settlement's idempotencyKey is
   * `settle:${executionId}:${supplierId}` — replaying with the same IDs
   * returns the existing Settlement without creating a duplicate.
   *
   * @param executionId  The execution being settled.
   * @param supplierId   The supplier receiving the settlement.
   * @param amount        Settlement amount, in integer minor units.
   * @param currency     ISO 4217 code (defaults to "USD").
   * @param environment  The environment of the settlement.
   * @returns            The created (or replayed) Settlement.
   */
  settleExecution(
    executionId: string,
    supplierId: string,
    amount: number,
    currency: string = "USD",
    environment: Environment = "SANDBOX",
  ): Settlement {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error(
        `Settlement amount must be a positive integer minor unit; got ${amount}.`,
      );
    }

    const idempotencyKey = `settle:${executionId}:${supplierId}`;
    const existing = this.settlements.get(idempotencyKey);
    if (existing) {
      return existing;
    }

    const settlement: Settlement = {
      id: nextSettlementId(),
      executionId,
      supplierId,
      amount,
      currency: currency.toUpperCase(),
      status: "SETTLED",
      idempotencyKey,
      environment,
      settledAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    this.settlements.set(idempotencyKey, settlement);
    return settlement;
  }

  /**
   * Mark a previously-created Settlement as FAILED (e.g. the external ACH
   * transfer bounced). Only SETTLED settlements can be marked failed.
   */
  markSettlementFailed(settlementId: string): Settlement {
    for (const s of this.settlements.values()) {
      if (s.id === settlementId) {
        if (s.status !== "SETTLED") {
          throw new Error(
            `Cannot fail settlement ${settlementId}: status is ${s.status} (must be SETTLED).`,
          );
        }
        const failed: Settlement = { ...s, status: "FAILED" };
        this.settlements.set(s.idempotencyKey, failed);
        return failed;
      }
    }
    throw new Error(`Settlement ${settlementId} not found.`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // PAYMENT INTENT FACTORY
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Create a new PaymentIntent in state PENDING. Convenience factory for
   * upstream code that needs to construct an intent before calling
   * authorizePayment().
   *
   * The caller must specify the money breakdown (userPrice,
   * supplierCompensation, platformFee) — these are typically derived from
   * the pricing engine or the negotiation outcome. The ledger does NOT
   * re-derive them; it records them verbatim.
   */
  createPaymentIntent(params: {
    demandId: string;
    customerId: string;
    supplierId: string;
    userPrice: number;
    supplierCompensation: number;
    platformFee: number;
    currency: string;
    environment: Environment;
    agreementId?: string;
    executionId?: string;
    idempotencyKey: string;
  }): PaymentIntent {
    const {
      demandId,
      customerId,
      supplierId,
      userPrice,
      supplierCompensation,
      platformFee,
      currency,
      environment,
      agreementId,
      executionId,
      idempotencyKey,
    } = params;

    if (supplierCompensation + platformFee !== userPrice) {
      throw new Error(
        `PaymentIntent money breakdown inconsistent: supplierCompensation ` +
          `(${supplierCompensation}) + platformFee (${platformFee}) != userPrice (${userPrice}).`,
      );
    }
    if (!idempotencyKey) {
      throw new Error("PaymentIntent idempotencyKey is required.");
    }

    return {
      id: nextIntentId(),
      demandId,
      agreementId,
      executionId,
      customerId,
      supplierId,
      amount: userPrice,
      userPrice,
      supplierCompensation,
      platformFee,
      currency: currency.toUpperCase(),
      status: "PENDING",
      idempotencyKey,
      environment,
      createdAt: new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // INTERNAL HELPERS
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Find the (first) account matching the given type + owner + currency +
   * environment. Throws if no match exists — callers are expected to
   * pre-create the customer/escrow/supplier/revenue accounts at user- and
   * provider-onboarding time.
   */
  private findAccount(
    type: AccountType,
    ownerId: string,
    currency: string,
    environment: Environment,
  ): MoneyAccount {
    const cur = currency.toUpperCase();
    for (const rec of this.accounts.values()) {
      const a = rec.account;
      if (
        a.type === type &&
        a.ownerId === ownerId &&
        a.currency === cur &&
        a.environment === environment
      ) {
        return a;
      }
    }
    throw new Error(
      `No ${type} account found for owner ${ownerId} in ${environment} (${cur}). ` +
        `Pre-create the account before calling the payment flow.`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // AUDIT
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Verify that the ledger is balanced: for every entry, its paired entry
   * exists, has the opposite type, and matches on amount / currency /
   * environment. Returns violations as human-readable strings.
   *
   * Used by the audit / verification layer (and by tests) to confirm that
   * the double-entry invariant holds. A balanced ledger is the foundational
   * invariant of double-entry bookkeeping — if this returns any violations,
   * the ledger is in an inconsistent state and must be reconciled.
   *
   * @returns  `{ ok, violations, totalAccounts, totalEntries }`.
   */
  audit(): {
    ok: boolean;
    violations: string[];
    totalAccounts: number;
    totalEntries: number;
  } {
    const violations: string[] = [];
    let totalEntries = 0;

    // Build a global index of entry ID → entry, across all accounts. This
    // lets us check pair linkage in O(1) per entry rather than O(n²) over
    // all entries.
    const entryIndex = new Map<string, LedgerEntry>();
    for (const rec of this.accounts.values()) {
      for (const entry of rec.entries) {
        entryIndex.set(entry.id, entry);
      }
    }

    // Walk every entry and verify its pair.
    for (const rec of this.accounts.values()) {
      for (const entry of rec.entries) {
        totalEntries += 1;
        const pair = entryIndex.get(entry.pairedEntryId);
        if (!pair) {
          violations.push(
            `Entry ${entry.id} has pairedEntryId ${entry.pairedEntryId} but no such entry exists.`,
          );
          continue;
        }
        // The pair's pair-link must point back to this entry.
        if (pair.pairedEntryId !== entry.id) {
          violations.push(
            `Entry ${entry.id} pairs with ${pair.id}, but ${pair.id} pairs back with ${pair.pairedEntryId} (expected ${entry.id}).`,
          );
        }
        // Opposite type.
        if (pair.type === entry.type) {
          violations.push(
            `Entry ${entry.id} (${entry.type}) paired with ${pair.id} (${pair.type}) — same type (expected opposite).`,
          );
        }
        // Matching amount.
        if (pair.amount !== entry.amount) {
          violations.push(
            `Entry ${entry.id} (amount ${entry.amount}) paired with ${pair.id} (amount ${pair.amount}) — amount mismatch.`,
          );
        }
        // Matching currency.
        if (pair.currency !== entry.currency) {
          violations.push(
            `Entry ${entry.id} (${entry.currency}) paired with ${pair.id} (${pair.currency}) — currency mismatch.`,
          );
        }
        // Matching environment (the hard boundary).
        if (pair.environment !== entry.environment) {
          violations.push(
            `Entry ${entry.id} (${entry.environment}) paired with ${pair.id} (${pair.environment}) — environment isolation violated.`,
          );
        }
        // Matching idempotencyKey.
        if (pair.idempotencyKey !== entry.idempotencyKey) {
          violations.push(
            `Entry ${entry.id} (key ${entry.idempotencyKey}) paired with ${pair.id} (key ${pair.idempotencyKey}) — idempotency key mismatch.`,
          );
        }
      }
    }

    return {
      ok: violations.length === 0,
      violations,
      totalAccounts: this.accounts.size,
      totalEntries,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// STANDALONE AUDIT HELPER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Standalone alias for `ledger.audit()`. Provided so callers can run an
 * audit without holding a long-lived reference to the ledger's typed
 * interface (e.g. in a generic middleware context).
 */
export function auditLedger(ledger: MoneyLedger): ReturnType<MoneyLedger["audit"]> {
  return ledger.audit();
}
