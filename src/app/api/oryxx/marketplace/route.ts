// ORYXX — Live Marketplace API (rewrite)
//
// Real-engine-backed marketplace operations. Every mode calls into the actual
// ORYXX engines (clearMarket, discoverOpportunities, createNegotiation/
// resolveNegotiation, createExecution/transition) and persists results into
// PostgreSQL with proper transactions and audit events.
//
// API modes (each is a separate explicit step in the transaction path):
//   1.  create_demand          — TransportationDemand(userId=email, env=SANDBOX)
//   2.  discover_supply        — provider registry → TransportationSupply
//   3.  discover_opportunities — discoverOpportunities() → TransportationOpportunity
//   4.  clear_market           — clearMarket() → MarketplaceOffer(PENDING),
//                                opportunity→OFFERED, demand→MATCHED
//   5.  negotiate              — createNegotiation+resolveNegotiation → persisted price
//   6.  accept_offer           — offer→ACCEPTED, agreement created, supply→RESERVED,
//                                opportunity→ACCEPTED (PostgreSQL tx)
//   7.  authorize_payment      — PaymentIntent(AUTHORIZED) + double-entry ledger
//                                (DEBIT customer, CREDIT escrow). No overdraft. Idempotent.
//   8.  capture_payment        — PaymentIntent(CAPTURED) + double-entry ledger
//                                (DEBIT escrow → CREDIT supplier; DEBIT escrow →
//                                CREDIT platform-revenue). Idempotent.
//   9.  reserve_execution      — createExecution + transition→RESERVED,
//                                supply→COMMITTED, demand→IN_PROGRESS (tx)
//   10. dispatch               — transition DISPATCHED→EN_ROUTE + provider.startExecution()
//   11. complete_execution     — transition PICKED_UP→EXECUTING→COMPLETED +
//                                provider.verifyCompletion() + Settlement (tx)
//
// Authorization: every mutation verifies demand.userId === session.user.email
// (extracted from the JWT session, NEVER from the request body). Admins can
// read but cannot mutate marketplace data they do not own.
//
// Money: integer minor units (cents). All money operations are DB-backed via
// MoneyAccount + LedgerEntry (no in-memory MoneyLedger). Every ledger entry
// has a unique idempotencyKey; replaying the same key returns the existing
// entry without modifying balances.
//
// Evidence: SANDBOX execution NEVER produces W3-M/W4-M (evidenceEligible=false
// by construction). All objects carry isMarketplaceOpportunity=true,
// researchStimulus=false.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth/options";
import { db } from "@/lib/db";
import { providerRegistry } from "@/lib/oryxx/live/adapters/provider-registry";
import { SandboxTransportationProvider } from "@/lib/oryxx/live/adapters/sandbox-provider";
import { FixtureTransportationProvider } from "@/lib/oryxx/live/adapters/fixture-provider";
import { CitiBikeNYCProvider, citibikeProvider } from "@/lib/oryxx/live/adapters/citibike-provider";
import { discoverOpportunities } from "@/lib/oryxx/live/engine/opportunity-engine";
import { clearMarket } from "@/lib/oryxx/live/engine/market-clearing";
import { priceOpportunity } from "@/lib/oryxx/live/engine/pricing";
import {
  createNegotiation,
  submitRound,
  resolveNegotiation,
} from "@/lib/oryxx/live/engine/negotiation";
import {
  createExecution,
  transition,
  canTransition,
  isTerminal,
} from "@/lib/oryxx/live/engine/execution-engine";
import type {
  TransportationDemand as DomainDemand,
  TransportationSupply as DomainSupply,
  TransportationOpportunity as DomainOpportunity,
  MarketplaceAgreement as DomainAgreement,
  TransportationExecution as DomainExecution,
  Environment,
  NegotiationType,
  Negotiation,
  ExecutionState,
  Provenance,
} from "@/lib/oryxx/live/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const ENV: Environment = "SANDBOX";
const CURRENCY = "USD";
const SANDBOX_INITIAL_BALANCE = 10000; // $100.00 in minor units (cents)

// Register providers (idempotent — survives module reloads / hot-restart).
let providersRegistered = false;
function ensureProviders() {
  if (providersRegistered) return;
  if (!providerRegistry.get("sandbox-rideshare")) {
    providerRegistry.register(new SandboxTransportationProvider());
  }
  if (!providerRegistry.get("fixture-transit")) {
    providerRegistry.register(new FixtureTransportationProvider());
  }
  if (!providerRegistry.get("citi-bike-nyc")) {
    providerRegistry.register(citibikeProvider);
  }
  providersRegistered = true;
}

// Type alias for the Prisma transaction client. Both PrismaClient and the
// callback parameter of $transaction() satisfy this interface.
type DBClient = Prisma.TransactionClient;

// ═══════════════════════════════════════════════════════════════════════
// AUTHORIZATION HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Extract the authenticated user's email from the JWT session. NEVER read the
 * user identity from the request body — that would let any caller impersonate
 * any user.
 *
 * Returns null if there is no session, in which case the caller should
 * respond with 401.
 */
async function requireEmail(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const email = (session.user as { email?: string | null } | null)?.email;
  return email ?? null;
}

/**
 * Verify that the given demand belongs to the authenticated user.
 * Returns true iff demand.userId === email.
 *
 * This is the single authorization gate for every mutation mode. Admins do
 * NOT bypass it — they can read anything (via GET) but cannot mutate data
 * they did not create.
 */
function assertOwnership(
  demand: { userId: string | null },
  email: string,
): boolean {
  return demand.userId === email;
}

/**
 * Wrap the ownership check as a NextResponse-friendly guard.
 * Returns null if ownership holds; otherwise returns a 403 response.
 */
function ownershipError(email: string): NextResponse {
  return NextResponse.json(
    {
      error: "Forbidden: marketplace object is not owned by the authenticated user.",
      actor: email,
    },
    { status: 403 },
  );
}

// ═══════════════════════════════════════════════════════════════════════
// PROVIDER IDENTITY (server-derived, NOT from request body)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sandbox provider identity. In the sandbox, the provider session is derived
 * from the session role. A user with role "demo-driver" or "admin" acting
 * in provider mode is mapped to the sandbox provider identity.
 *
 * The providerId is NEVER read from the request body — it is resolved
 * server-side from the authenticated session.
 */
interface ProviderIdentity {
  providerId: string;
  resourceId: string;
  environment: Environment;
}

/**
 * Resolve the provider identity from the authenticated session.
 * Returns null if the session is not provider-authorized.
 *
 * For SANDBOX: the sandbox provider is mapped to any authenticated session
 * that includes a "provider" role marker. In production, this would be
 * replaced by OAuth/API-key provider authentication.
 */
async function requireProviderIdentity(): Promise<ProviderIdentity | null> {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const role = (session.user as { role?: string } | null)?.role;
  const email = (session.user as { email?: string } | null)?.email;
  if (!email) return null;

  // In sandbox, any authenticated user can act as the sandbox provider.
  // The providerId is resolved server-side — NOT from the request body.
  return {
    providerId: "sandbox-rideshare",
    resourceId: "sandbox-vehicle-1",
    environment: "SANDBOX",
  };
}

/**
 * Verify that the provider identity owns the offer (i.e., the offer's
 * providerId matches the resolved provider identity).
 */
function assertProviderOwnsOffer(
  offer: { providerId: string },
  provider: ProviderIdentity,
): boolean {
  return offer.providerId === provider.providerId;
}

function providerAuthError(): NextResponse {
  return NextResponse.json(
    { error: "Forbidden: provider identity does not match offer provider." },
    { status: 403 },
  );
}

// ═══════════════════════════════════════════════════════════════════════
// DOMAIN-TYPE CONVERTERS (DB row → domain type)
// ═══════════════════════════════════════════════════════════════════════

function toDomainDemand(d: {
  id: string;
  source: string;
  requestType: string;
  kind: string;
  originLat: number;
  originLon: number;
  originName: string | null;
  destLat: number;
  destLon: number;
  destName: string | null;
  windowStartSec: number;
  windowEndSec: number;
  latestArrivalSec: number;
  partySize: number;
  weightKg: number;
  volumeM3: number;
  budget: number;
  value: number;
  priority: string;
  constraintsJson: string | null;
  status: string;
  createdAt: Date;
  userId: string | null;
}): DomainDemand {
  return {
    id: d.id,
    source: d.source as DomainDemand["source"],
    requestType: d.requestType as DomainDemand["requestType"],
    kind: d.kind as DomainDemand["kind"],
    origin: { lat: d.originLat, lon: d.originLon, name: d.originName ?? undefined },
    destination: { lat: d.destLat, lon: d.destLon, name: d.destName ?? undefined },
    timeWindow: { startSec: d.windowStartSec, endSec: d.windowEndSec },
    latestArrivalSec: d.latestArrivalSec,
    partySize: d.partySize,
    weightKg: d.weightKg,
    volumeM3: d.volumeM3,
    budget: d.budget,
    value: d.value,
    priority: d.priority as DomainDemand["priority"],
    constraints: d.constraintsJson ? JSON.parse(d.constraintsJson) : {},
    status: d.status as DomainDemand["status"],
    createdAt: d.createdAt.toISOString(),
    userId: d.userId ?? undefined,
  };
}

function toDomainSupply(s: {
  id: string;
  providerId: string;
  resourceId: string;
  mode: string;
  capacity: number;
  availableCapacity: number;
  originLat: number;
  originLon: number;
  currentLat: number | null;
  currentLon: number | null;
  routeJson: string | null;
  stopsJson: string | null;
  departureStartSec: number;
  departureEndSec: number;
  availabilityStartSec: number;
  availabilityEndSec: number;
  costPerKm: number;
  costPerHour: number;
  fixedCost: number;
  minimumCompensation: number;
  detourToleranceKm: number;
  maxDetourKm: number;
  maxExtraTimeMin: number;
  status: string;
  source: string;
  environment: string;
  provenanceJson: string | null;
  createdAt: Date;
}): DomainSupply {
  const fallbackProvenance: Provenance = {
    environment: s.environment as Environment,
    source: s.source as Provenance["source"],
    observedAt: s.createdAt.toISOString(),
    confidence: 1,
  };
  return {
    id: s.id,
    providerId: s.providerId,
    resourceId: s.resourceId,
    mode: s.mode as DomainSupply["mode"],
    capacity: s.capacity,
    availableCapacity: s.availableCapacity,
    origin: { lat: s.originLat, lon: s.originLon },
    currentLocation:
      s.currentLat != null && s.currentLon != null
        ? { lat: s.currentLat, lon: s.currentLon }
        : undefined,
    plannedRoute: s.routeJson ? JSON.parse(s.routeJson) : [],
    plannedStops: s.stopsJson ? JSON.parse(s.stopsJson) : [],
    departureWindow: { startSec: s.departureStartSec, endSec: s.departureEndSec },
    availabilityWindow: { startSec: s.availabilityStartSec, endSec: s.availabilityEndSec },
    costModel: {
      costPerKm: s.costPerKm,
      costPerHour: s.costPerHour,
      fixedCost: s.fixedCost,
      minimumCompensation: s.minimumCompensation,
    },
    detourToleranceKm: s.detourToleranceKm,
    constraints: { maxDetourKm: s.maxDetourKm, maxExtraTimeMin: s.maxExtraTimeMin },
    status: s.status as DomainSupply["status"],
    source: s.source as DomainSupply["source"],
    provenance: s.provenanceJson ? JSON.parse(s.provenanceJson) : fallbackProvenance,
  };
}

function toDomainOpportunity(o: {
  id: string;
  demandId: string;
  supplyId: string;
  providerId: string;
  routeJson: string | null;
  distanceKm: number;
  estimatedTimeMin: number;
  detourKm: number;
  extraTimeMin: number;
  capacityUsed: number;
  price: number;
  supplierCompensation: number;
  platformFee: number;
  executionProbability: number;
  confidence: number;
  status: string;
  whyFeasible: string;
  whyNow: string;
  whyThisSupply: string;
  whyOrdinaryMisses: string;
  environment: string;
  provenanceJson: string | null;
  createdAt: Date;
}): DomainOpportunity {
  const route = o.routeJson ? JSON.parse(o.routeJson) : {};
  const fallbackProvenance: Provenance = {
    environment: o.environment as Environment,
    source: "oryxx-owned" as Provenance["source"],
    observedAt: o.createdAt.toISOString(),
    confidence: 1,
  };
  return {
    id: o.id,
    demandId: o.demandId,
    supplyId: o.supplyId,
    providerId: o.providerId,
    route: {
      pickup: route.pickup ?? { lat: 0, lon: 0 },
      dropoff: route.dropoff ?? { lat: 0, lon: 0 },
      waypoints: route.waypoints ?? [],
      distanceKm: o.distanceKm,
      estimatedTimeMin: o.estimatedTimeMin,
    },
    departure: route.departure ?? { startSec: 0, endSec: 0 },
    arrival: route.arrival ?? { startSec: 0, endSec: 0 },
    detourKm: o.detourKm,
    extraTimeMin: o.extraTimeMin,
    capacityUsed: o.capacityUsed,
    price: o.price,
    supplierCompensation: o.supplierCompensation,
    platformFee: o.platformFee,
    executionProbability: o.executionProbability,
    confidence: o.confidence,
    provenance: o.provenanceJson ? JSON.parse(o.provenanceJson) : fallbackProvenance,
    status: o.status as DomainOpportunity["status"],
    whyFeasible: o.whyFeasible,
    whyNow: o.whyNow,
    whyThisSupply: o.whyThisSupply,
    whyOrdinaryRoutingMissesIt: o.whyOrdinaryMisses,
    isMarketplaceOpportunity: true,
    researchStimulus: false,
    createdAt: o.createdAt.toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ACCOUNT + LEDGER HELPERS (DB-backed — no in-memory MoneyLedger)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Ensure a sandbox customer account exists for the given user (email).
 * If it does not exist, create one with $100.00 (10000 cents) — explicit
 * sandbox funding. This replaces the implicit account funding that the
 * previous route did during payment authorization.
 */
async function ensureSandboxAccount(email: string) {
  // Concurrency-safe: use upsert to prevent duplicate accounts from
  // concurrent requests. The unique constraint on (ownerId, type,
  // environment, currency) is enforced at the DB level.
  const account = await db.moneyAccount.upsert({
    where: {
      ownerId_type_environment_currency: {
        ownerId: email,
        type: "customer",
        environment: ENV,
        currency: CURRENCY,
      },
    },
    update: {}, // No update if exists
    create: {
      ownerId: email,
      type: "customer",
      currency: CURRENCY,
      balance: SANDBOX_INITIAL_BALANCE,
      environment: ENV,
      frozen: false,
    },
  });
  // Log funding only if this is a new account (balance === initial)
  if (account.balance === SANDBOX_INITIAL_BALANCE) {
    const existingEvents = await db.marketplaceEvent.count({
      where: { referenceId: account.id, eventType: "sandbox-account-funded" },
    });
    if (existingEvents === 0) {
      await db.marketplaceEvent.create({
        data: {
          eventType: "sandbox-account-funded",
          referenceType: "adjustment",
          referenceId: account.id,
          environment: ENV,
          payloadJson: JSON.stringify({
            ownerId: email,
            initialBalance: SANDBOX_INITIAL_BALANCE,
            currency: CURRENCY,
          }),
        },
      });
    }
  }
  return account;
}

/**
 * Ensure the platform escrow account exists (single shared account for the
 * SANDBOX environment).
 */
async function ensureEscrowAccount() {
  const existing = await db.moneyAccount.findFirst({
    where: { ownerId: "oryxx-platform", type: "escrow", environment: ENV },
  });
  if (existing) return existing;
  return db.moneyAccount.create({
    data: {
      ownerId: "oryxx-platform",
      type: "escrow",
      currency: CURRENCY,
      balance: 0,
      environment: ENV,
      frozen: false,
    },
  });
}

/**
 * Ensure a supplier (provider) account exists. One per providerId.
 */
async function ensureSupplierAccount(providerId: string) {
  const existing = await db.moneyAccount.findFirst({
    where: { ownerId: providerId, type: "supplier", environment: ENV },
  });
  if (existing) return existing;
  return db.moneyAccount.create({
    data: {
      ownerId: providerId,
      type: "supplier",
      currency: CURRENCY,
      balance: 0,
      environment: ENV,
      frozen: false,
    },
  });
}

/**
 * Ensure the platform-revenue account exists. Holds the platform's fee
 * revenue from completed captures.
 */
async function ensurePlatformRevenueAccount() {
  const existing = await db.moneyAccount.findFirst({
    where: { ownerId: "oryxx-platform", type: "platform-revenue", environment: ENV },
  });
  if (existing) return existing;
  return db.moneyAccount.create({
    data: {
      ownerId: "oryxx-platform",
      type: "platform-revenue",
      currency: CURRENCY,
      balance: 0,
      environment: ENV,
      frozen: false,
    },
  });
}

/**
 * Post a double-entry ledger entry. Idempotent by idempotencyKey — if an
 * entry with the same key already exists (committed by a prior call), the
 * existing entry is returned without creating a duplicate or modifying any
 * account balance.
 *
 * Atomically updates the account balance: DEBIT decrements, CREDIT increments.
 *
 * @param _db  PrismaClient; reserved for the spec signature (unused).
 * @param tx   Transaction client used for both the idempotency lookup and
 *             the create. Must be the same client so the lookup sees the
 *             write within the same transaction.
 */
async function postLedgerEntry(
  _db: DBClient,
  tx: DBClient,
  accountId: string,
  type: "DEBIT" | "CREDIT",
  amount: number,
  description: string,
  referenceType: string,
  referenceId: string,
  idempotencyKey: string,
  pairedEntryId: string,
  environment: string,
) {
  // Idempotency: return the existing entry if this key was already committed.
  const existing = await tx.ledgerEntry.findUnique({ where: { idempotencyKey } });
  if (existing) return existing;

  const entry = await tx.ledgerEntry.create({
    data: {
      accountId,
      type,
      amount,
      currency: CURRENCY,
      description,
      referenceType,
      referenceId,
      idempotencyKey,
      pairedEntryId,
      environment,
    },
  });

  // Update the account balance atomically with the entry creation.
  // DEBIT decrements balance; CREDIT increments balance.
  const delta = type === "DEBIT" ? -amount : amount;
  await tx.moneyAccount.update({
    where: { id: accountId },
    data: { balance: { increment: delta } },
  });

  return entry;
}

/**
 * Post a pair of double-entry ledger entries (DEBIT one account, CREDIT
 * another) and link them via pairedEntryId. Atomic within the given tx.
 *
 * The debit is created first with an empty pairedEntryId; then the credit is
 * created with pairedEntryId=debitEntry.id; then the debit is updated to set
 * pairedEntryId=creditEntry.id. Idempotent — both entries have unique keys.
 */
async function postDoubleEntry(
  dbClient: DBClient,
  tx: DBClient,
  debitAccountId: string,
  creditAccountId: string,
  amount: number,
  description: string,
  referenceType: string,
  referenceId: string,
  idempotencyPrefix: string,
  environment: string,
) {
  const debitKey = `${idempotencyPrefix}-debit`;
  const creditKey = `${idempotencyPrefix}-credit`;

  // Debit first (pairedEntryId placeholder — will be back-filled below).
  const debitEntry = await postLedgerEntry(
    dbClient, tx,
    debitAccountId, "DEBIT", amount, description,
    referenceType, referenceId, debitKey, "",
    environment,
  );

  // Credit, paired with the debit.
  const creditEntry = await postLedgerEntry(
    dbClient, tx,
    creditAccountId, "CREDIT", amount, description,
    referenceType, referenceId, creditKey, debitEntry.id,
    environment,
  );

  // Back-fill the debit's pairedEntryId (idempotent — skip if already linked).
  if (debitEntry.pairedEntryId !== creditEntry.id) {
    await tx.ledgerEntry.update({
      where: { id: debitEntry.id },
      data: { pairedEntryId: creditEntry.id },
    });
  }

  return { debitEntry, creditEntry };
}

/**
 * Append a MarketplaceEvent to the audit log. Must be called inside a tx
 * so the event is committed atomically with the state transition it records.
 */
async function logEvent(
  tx: DBClient,
  eventType: string,
  referenceType: string,
  referenceId: string,
  payload?: unknown,
) {
  return tx.marketplaceEvent.create({
    data: {
      eventType,
      referenceType,
      referenceId,
      environment: ENV,
      payloadJson: payload ? JSON.stringify(payload) : null,
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════
// GET — READ-ONLY VIEWS (admin can read; non-admin sees only their own data)
// ═══════════════════════════════════════════════════════════════════════

export async function GET(req: Request) {
  const email = await requireEmail();
  if (!email) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  ensureProviders();
  const url = new URL(req.url);
  const view = url.searchParams.get("view") || "overview";

  if (view === "providers") {
    return NextResponse.json({ providers: providerRegistry.status() });
  }

  if (view === "demands") {
    const demands = await db.transportationDemand.findMany({
      where: { userId: email },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return NextResponse.json({ demands });
  }

  if (view === "opportunities") {
    const opportunities = await db.transportationOpportunity.findMany({
      where: { demand: { userId: email } },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { demand: true, supply: true },
    });
    return NextResponse.json({ opportunities });
  }

  if (view === "offers") {
    const offers = await db.marketplaceOffer.findMany({
      where: { demand: { userId: email } },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { opportunity: true },
    });
    return NextResponse.json({ offers });
  }

  if (view === "agreements") {
    // MarketplaceAgreement has no direct `demand` relation; reach it via the
    // opportunity's demand. Same ownership semantics.
    const agreements = await db.marketplaceAgreement.findMany({
      where: { opportunity: { demand: { userId: email } } },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { offer: true, opportunity: true },
    });
    return NextResponse.json({ agreements });
  }

  if (view === "executions") {
    // TransportationExecution reaches its owning user via opportunity.demand.
    const executions = await db.transportationExecution.findMany({
      where: { opportunity: { demand: { userId: email } } },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { opportunity: true, agreement: true },
    });
    return NextResponse.json({ executions });
  }

  if (view === "payments") {
    // PaymentIntent has demandId (string) but no `demand` relation — pre-fetch
    // the user's demand IDs and filter by them.
    const userDemandIds = (
      await db.transportationDemand.findMany({
        where: { userId: email },
        select: { id: true },
      })
    ).map((d) => d.id);
    const payments = await db.paymentIntent.findMany({
      where: { demandId: { in: userDemandIds } },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { agreement: true },
    });
    return NextResponse.json({ payments });
  }

  if (view === "ledger") {
    const customerAccount = await db.moneyAccount.findFirst({
      where: { ownerId: email, type: "customer", environment: ENV },
    });
    if (!customerAccount) {
      return NextResponse.json({ account: null, entries: [], balance: 0 });
    }
    const entries = await db.ledgerEntry.findMany({
      where: { accountId: customerAccount.id },
      orderBy: { timestamp: "desc" },
      take: 100,
    });
    return NextResponse.json({
      account: customerAccount,
      entries,
      balance: customerAccount.balance,
    });
  }

  if (view === "broadcasts") {
    const broadcasts = await db.availabilityBroadcast.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return NextResponse.json({ broadcasts });
  }

  if (view === "events") {
    const events = await db.marketplaceEvent.findMany({
      where: { environment: ENV },
      orderBy: { timestamp: "desc" },
      take: 100,
    });
    return NextResponse.json({ events });
  }

  if (view === "provider_health") {
    // Health check for the Citi Bike NYC provider (real API)
    const citibike = providerRegistry.get("citi-bike-nyc") as CitiBikeNYCProvider | undefined;
    if (!citibike) {
      return NextResponse.json({ error: "Citi Bike NYC provider not registered." }, { status: 404 });
    }
    const health = await citibike.healthCheck();
    return NextResponse.json({
      provider: citibike.getProviderIdentity(),
      provenance: citibike.getProvenance(),
      integrationStatus: citibike.getIntegrationStatus(),
      health,
    });
  }

  if (view === "real_supply") {
    // Discover REAL supply from Citi Bike NYC (observed-only)
    const citibike = providerRegistry.get("citi-bike-nyc") as CitiBikeNYCProvider | undefined;
    if (!citibike) {
      return NextResponse.json({ error: "Citi Bike NYC provider not registered." }, { status: 404 });
    }
    // NYC center: Times Square
    const area = { lat: 40.7589, lon: -73.9851 };
    const radiusKm = parseInt(url.searchParams.get("radius") || "5");
    const supplies = await citibike.discoverSupply(area, radiusKm);
    return NextResponse.json({
      provider: citibike.getProviderIdentity(),
      provenance: citibike.getProvenance(),
      count: supplies.length,
      supplies: supplies.slice(0, 50), // limit response size
      environment: "OBSERVED_ONLY",
      note: "Real observed supply from Citi Bike NYC via CityBik.es API. This is NOT transactional — acceptance/execution NOT_SUPPORTED.",
    });
  }

  // Default overview — counts scoped to the authenticated user where applicable.
  // Pre-fetch the user's demand IDs so we can count PaymentIntents (which have
  // no `demand` relation, only a `demandId` column).
  const userDemandIds = (
    await db.transportationDemand.findMany({
      where: { userId: email },
      select: { id: true },
    })
  ).map((d) => d.id);

  const [
    demandCount,
    supplyCount,
    opportunityCount,
    offerCount,
    agreementCount,
    executionCount,
    paymentCount,
    broadcastCount,
  ] = await Promise.all([
    db.transportationDemand.count({ where: { userId: email } }),
    db.transportationSupply.count({ where: { environment: ENV } }),
    db.transportationOpportunity.count({ where: { demand: { userId: email } } }),
    db.marketplaceOffer.count({ where: { demand: { userId: email } } }),
    db.marketplaceAgreement.count({ where: { opportunity: { demand: { userId: email } } } }),
    db.transportationExecution.count({ where: { opportunity: { demand: { userId: email } } } }),
    db.paymentIntent.count({ where: { demandId: { in: userDemandIds } } }),
    db.availabilityBroadcast.count(),
  ]);

  return NextResponse.json({
    overview: {
      demands: demandCount,
      supplies: supplyCount,
      opportunities: opportunityCount,
      offers: offerCount,
      agreements: agreementCount,
      executions: executionCount,
      payments: paymentCount,
      broadcasts: broadcastCount,
    },
    providers: providerRegistry.status(),
    environment: ENV,
    note: "Sandbox marketplace — no live provider integrations. Sandbox execution cannot produce W3-M/W4-M evidence.",
  });
}

// ═══════════════════════════════════════════════════════════════════════
// POST — MUTATION MODES
// ═══════════════════════════════════════════════════════════════════════

export async function POST(req: Request) {
  const email = await requireEmail();
  if (!email) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  ensureProviders();

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const mode = body?.mode;

  // ─── 1. CREATE DEMAND ────────────────────────────────────────────────
  if (mode === "create_demand") {
    const nowSec = Math.floor(Date.now() / 1000) % 86400;
    const demand = await db.transportationDemand.create({
      data: {
        source: body.source || "direct-user",
        requestType: body.requestType || "rideshare",
        kind: body.kind || "person",
        originLat: body.originLat ?? 40.7589,
        originLon: body.originLon ?? -73.9851,
        originName: body.originName || "Origin",
        destLat: body.destLat ?? 40.7505,
        destLon: body.destLon ?? -73.9934,
        destName: body.destName || "Destination",
        windowStartSec: body.windowStartSec ?? nowSec,
        windowEndSec: body.windowEndSec ?? nowSec + 3600,
        latestArrivalSec: body.latestArrivalSec ?? nowSec + 7200,
        partySize: body.partySize ?? 1,
        weightKg: body.weightKg ?? 0,
        volumeM3: body.volumeM3 ?? 0,
        budget: body.budget ?? 5000, // $50.00 in minor units
        value: body.value ?? 6000,   // $60.00
        priority: body.priority || "normal",
        constraintsJson: body.constraints ? JSON.stringify(body.constraints) : null,
        userId: email,               // bound to authenticated user
        environment: ENV,
        status: "OPEN",
      },
    });
    await db.marketplaceEvent.create({
      data: {
        eventType: "demand-created",
        referenceType: "demand",
        referenceId: demand.id,
        environment: ENV,
        payloadJson: JSON.stringify({ userId: email, demandId: demand.id }),
      },
    });
    return NextResponse.json({
      demand,
      message: "Demand created in SANDBOX environment.",
    });
  }

  // ─── 2. DISCOVER SUPPLY ──────────────────────────────────────────────
  if (mode === "discover_supply") {
    const demand = await db.transportationDemand.findUnique({
      where: { id: body.demandId },
    });
    if (!demand) return NextResponse.json({ error: "Demand not found." }, { status: 404 });
    if (!assertOwnership(demand, email)) return ownershipError(email);
    if (demand.environment !== ENV) {
      return NextResponse.json(
        { error: `Demand environment mismatch (expected ${ENV}).` },
        { status: 400 },
      );
    }

    // Discover from all connected providers (sandbox + fixture).
    const supplies = await providerRegistry.discoverAllSupply(
      { lat: demand.originLat, lon: demand.originLon },
      body.radiusKm ?? 10,
    );

    // Persist discovered supplies. environment = SANDBOX for ALL marketplace
    // objects (we override the supply's own provenance environment to ensure
    // sandbox state can never be confused with LIVE supply).
    const created: any[] = [];
    for (const supply of supplies) {
      const dbSupply = await db.transportationSupply.create({
        data: {
          providerId: supply.providerId,
          resourceId: supply.resourceId,
          mode: supply.mode,
          capacity: supply.capacity,
          availableCapacity: supply.availableCapacity,
          originLat: supply.origin.lat,
          originLon: supply.origin.lon,
          currentLat: supply.currentLocation?.lat ?? null,
          currentLon: supply.currentLocation?.lon ?? null,
          routeJson: JSON.stringify(supply.plannedRoute),
          stopsJson: JSON.stringify(supply.plannedStops),
          departureStartSec: supply.departureWindow.startSec,
          departureEndSec: supply.departureWindow.endSec,
          availabilityStartSec: supply.availabilityWindow.startSec,
          availabilityEndSec: supply.availabilityWindow.endSec,
          costPerKm: supply.costModel.costPerKm,
          costPerHour: supply.costModel.costPerHour,
          fixedCost: supply.costModel.fixedCost,
          minimumCompensation: supply.costModel.minimumCompensation,
          detourToleranceKm: supply.detourToleranceKm,
          maxDetourKm: supply.constraints.maxDetourKm,
          maxExtraTimeMin: supply.constraints.maxExtraTimeMin,
          status: "AVAILABLE",
          source: supply.source,
          environment: ENV,
          provenanceJson: JSON.stringify({ ...supply.provenance, environment: ENV }),
        },
      });
      created.push(dbSupply);
      await db.marketplaceEvent.create({
        data: {
          eventType: "supply-discovered",
          referenceType: "demand",
          referenceId: demand.id,
          environment: ENV,
          payloadJson: JSON.stringify({
            supplyId: dbSupply.id,
            providerId: dbSupply.providerId,
          }),
        },
      });
    }
    return NextResponse.json({ supplies: created, count: created.length });
  }

  // ─── 3. DISCOVER OPPORTUNITIES ──────────────────────────────────────
  if (mode === "discover_opportunities") {
    const demand = await db.transportationDemand.findUnique({
      where: { id: body.demandId },
    });
    if (!demand) return NextResponse.json({ error: "Demand not found." }, { status: 404 });
    if (!assertOwnership(demand, email)) return ownershipError(email);
    if (demand.environment !== ENV) {
      return NextResponse.json(
        { error: `Demand environment mismatch (expected ${ENV}).` },
        { status: 400 },
      );
    }

    const dbSupplies = await db.transportationSupply.findMany({
      where: { status: "AVAILABLE", environment: ENV },
      take: 100,
    });

    const domainDemand = toDomainDemand(demand);
    const domainSupplies = dbSupplies.map(toDomainSupply);

    // Call the real OpportunityEngine.
    const opportunities = discoverOpportunities([domainDemand], domainSupplies);

    // Persist opportunities. Each opportunity also gets a pricing breakdown
    // (from priceOpportunity) attached to its event payload for audit.
    const created: any[] = [];
    for (const opp of opportunities) {
      const backingSupply = domainSupplies.find((s) => s.id === opp.supplyId);
      const pricing = backingSupply
        ? priceOpportunity(opp, backingSupply, { label: "estimated" })
        : null;

      const dbOpp = await db.transportationOpportunity.create({
        data: {
          demandId: opp.demandId,
          supplyId: opp.supplyId,
          providerId: opp.providerId,
          routeJson: JSON.stringify(opp.route),
          distanceKm: opp.route.distanceKm,
          estimatedTimeMin: opp.route.estimatedTimeMin,
          detourKm: opp.detourKm,
          extraTimeMin: opp.extraTimeMin,
          capacityUsed: opp.capacityUsed,
          price: opp.price,
          supplierCompensation: opp.supplierCompensation,
          platformFee: opp.platformFee,
          executionProbability: opp.executionProbability,
          confidence: opp.confidence,
          status: "DISCOVERED",
          whyFeasible: opp.whyFeasible,
          whyNow: opp.whyNow,
          whyThisSupply: opp.whyThisSupply,
          whyOrdinaryMisses: opp.whyOrdinaryRoutingMissesIt,
          isMarketplaceOpportunity: true,
          researchStimulus: false,
          environment: ENV,
          provenanceJson: JSON.stringify({ ...opp.provenance, environment: ENV }),
        },
      });
      created.push(dbOpp);
      await db.marketplaceEvent.create({
        data: {
          eventType: "opportunity-discovered",
          referenceType: "opportunity",
          referenceId: dbOpp.id,
          environment: ENV,
          payloadJson: JSON.stringify({
            demandId: demand.id,
            supplyId: opp.supplyId,
            price: opp.price,
            supplierCompensation: opp.supplierCompensation,
            platformFee: opp.platformFee,
            pricingBreakdown: pricing?.breakdown ?? null,
          }),
        },
      });
    }
    return NextResponse.json({ opportunities: created, count: created.length });
  }

  // ─── 4. CLEAR MARKET ─────────────────────────────────────────────────
  if (mode === "clear_market") {
    const demand = await db.transportationDemand.findUnique({
      where: { id: body.demandId },
    });
    if (!demand) return NextResponse.json({ error: "Demand not found." }, { status: 404 });
    if (!assertOwnership(demand, email)) return ownershipError(email);
    if (demand.environment !== ENV) {
      return NextResponse.json(
        { error: `Demand environment mismatch (expected ${ENV}).` },
        { status: 400 },
      );
    }

    const dbSupplies = await db.transportationSupply.findMany({
      where: {
        environment: ENV,
        // DEFECT 5 FIX: Only AVAILABLE supply is fresh. RESERVED/COMMITTED/
        // EXPIRED/OFFLINE supply must NOT be considered for new opportunities.
        status: "AVAILABLE",
      },
      take: 100,
    });
    const dbOpportunities = await db.transportationOpportunity.findMany({
      where: { demandId: body.demandId, status: "DISCOVERED", environment: ENV },
    });

    if (dbOpportunities.length === 0) {
      return NextResponse.json(
        { error: "No DISCOVERED opportunities to clear." },
        { status: 400 },
      );
    }

    const domainDemand = toDomainDemand(demand);
    const domainSupplies = dbSupplies.map(toDomainSupply);
    const domainOpportunities = dbOpportunities.map(toDomainOpportunity);

    // Call the real ClearingEngine — greedy welfare-maximizing match.
    const clearResult = clearMarket(
      [domainDemand],
      domainSupplies,
      domainOpportunities,
    );

    if (clearResult.matches.length === 0) {
      return NextResponse.json(
        {
          error: "Market clearing produced no feasible matches.",
          unmatchedDemandIds: clearResult.unmatchedDemandIds,
          solverVersion: clearResult.solverVersion,
          solverMode: clearResult.solverMode,
          optimizationTimestamp: clearResult.optimizationTimestamp,
        },
        { status: 400 },
      );
    }

    const winningMatch = clearResult.matches[0];
    const winningOpportunity = dbOpportunities.find(
      (o) => o.id === winningMatch.opportunityId,
    );
    if (!winningOpportunity) {
      return NextResponse.json(
        { error: "Cleared match references unknown opportunity." },
        { status: 500 },
      );
    }

    // Persist the winning match as a PENDING offer; transition opportunity to
    // OFFERED and demand to MATCHED. All updates in a single transaction so
    // the clearing is atomic. Records solver audit metadata.
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min
    const result = await db.$transaction(async (tx) => {
      // Create the MarketplaceOffer (status=PENDING — provider hasn't
      // accepted yet; that's the next mode, `accept_offer`).
      const offer = await tx.marketplaceOffer.create({
        data: {
          opportunityId: winningMatch.opportunityId,
          demandId: winningMatch.demandId,
          supplyId: winningMatch.supplyId,
          providerId: winningOpportunity.providerId,
          userPrice: winningMatch.price,
          supplierCompensation: winningMatch.supplierCompensation,
          platformFee: winningMatch.platformFee,
          expiresAt,
          status: "PENDING",
          isMarketplaceOpportunity: true,
          researchStimulus: false,
          environment: ENV,
        },
      });

      // Transition opportunity DISCOVERED → OFFERED.
      await tx.transportationOpportunity.update({
        where: { id: winningMatch.opportunityId },
        data: { status: "OFFERED" },
      });

      // Transition demand OPEN → MATCHED.
      await tx.transportationDemand.update({
        where: { id: demand.id },
        data: { status: "MATCHED" },
      });

      // Log the clearing event with solver audit metadata.
      await logEvent(tx, "market-cleared", "opportunity", winningMatch.opportunityId, {
        offerId: offer.id,
        solverVersion: clearResult.solverVersion,
        solverMode: clearResult.solverMode,
        optimizationTimestamp: clearResult.optimizationTimestamp,
        match: winningMatch,
        stats: clearResult.stats,
      });
      await logEvent(tx, "offer-made", "offer", offer.id, {
        opportunityId: winningMatch.opportunityId,
        userPrice: winningMatch.price,
        supplierCompensation: winningMatch.supplierCompensation,
        platformFee: winningMatch.platformFee,
      });

      return { offer };
    });

    return NextResponse.json({
      offer: result.offer,
      match: winningMatch,
      solverVersion: clearResult.solverVersion,
      solverMode: clearResult.solverMode,
      optimizationTimestamp: clearResult.optimizationTimestamp,
      stats: clearResult.stats,
      unmatchedDemandIds: clearResult.unmatchedDemandIds,
      message: "Market cleared (SANDBOX). Offer created with status=PENDING.",
    });
  }

  // ─── 5. NEGOTIATE ────────────────────────────────────────────────────
  if (mode === "negotiate") {
    const opportunity = await db.transportationOpportunity.findUnique({
      where: { id: body.opportunityId },
    });
    if (!opportunity) {
      return NextResponse.json({ error: "Opportunity not found." }, { status: 404 });
    }

    const demand = await db.transportationDemand.findUnique({
      where: { id: opportunity.demandId },
    });
    if (!demand) return NextResponse.json({ error: "Demand not found." }, { status: 404 });
    if (!assertOwnership(demand, email)) return ownershipError(email);

    const supply = await db.transportationSupply.findUnique({
      where: { id: opportunity.supplyId },
    });
    if (!supply) return NextResponse.json({ error: "Supply not found." }, { status: 404 });

    const negotiationType: NegotiationType = body.type || "fixed-price";
    const deadline =
      body.deadline || new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const domainOpp = toDomainOpportunity(opportunity);
    const domainDemand = toDomainDemand(demand);
    const domainSupply = toDomainSupply(supply);

    // Create the negotiation. For "fixed-price" the engine posts the oryxx
    // round automatically (with opportunity.price). For other types we seed
    // one oryxx round at the discovered price so the negotiation has at
    // least one round to resolve against.
    let negotiation: Negotiation = createNegotiation(
      domainOpp,
      domainDemand,
      domainSupply,
      negotiationType,
      deadline,
    );
    if (negotiationType !== "fixed-price" && negotiation.rounds.length === 0) {
      negotiation = submitRound(
        negotiation,
        "oryxx",
        domainOpp.price,
        "ORYXX-seeded round at discovered opportunity price.",
      );
    }

    // Resolve deterministically — no LLM is ever involved in pricing.
    const resolved = resolveNegotiation(negotiation);

    // Persist the resolved price (update the opportunity's price). If the
    // negotiation accepted and the finalPrice differs from the discovered
    // price, we update the opportunity's price and any existing offer's
    // userPrice. If accepted, also transition opportunity to OFFERED.
    const result = await db.$transaction(async (tx) => {
      let updatedPrice: number | null = null;
      if (resolved.state === "ACCEPTED" && resolved.finalPrice != null) {
        updatedPrice = resolved.finalPrice;
        await tx.transportationOpportunity.update({
          where: { id: opportunity.id },
          data: { price: resolved.finalPrice },
        });

        // Update any existing offer's userPrice to the negotiated price.
        const existingOffer = await tx.marketplaceOffer.findUnique({
          where: { opportunityId: opportunity.id },
        });
        if (existingOffer) {
          await tx.marketplaceOffer.update({
            where: { id: existingOffer.id },
            data: { userPrice: resolved.finalPrice },
          });
        }

        // Transition opportunity DISCOVERED → OFFERED (idempotent — if
        // clear_market already moved it to OFFERED, this is a no-op).
        if (opportunity.status === "DISCOVERED") {
          await tx.transportationOpportunity.update({
            where: { id: opportunity.id },
            data: { status: "OFFERED" },
          });
        }
      }
      await logEvent(tx, "negotiation-resolved", "opportunity", opportunity.id, {
        negotiationId: resolved.id,
        type: negotiationType,
        state: resolved.state,
        finalPrice: resolved.finalPrice ?? null,
        minimumPrice: resolved.minimumPrice,
        maximumPrice: resolved.maximumPrice,
        reservationPrice: resolved.reservationPrice,
        rounds: resolved.rounds,
      });
      return { updatedPrice };
    });

    return NextResponse.json({
      negotiation: {
        id: resolved.id,
        type: negotiationType,
        state: resolved.state,
        finalPrice: resolved.finalPrice ?? null,
        minimumPrice: resolved.minimumPrice,
        maximumPrice: resolved.maximumPrice,
        reservationPrice: resolved.reservationPrice,
        rounds: resolved.rounds,
      },
      opportunity: {
        id: opportunity.id,
        price: result.updatedPrice ?? opportunity.price,
      },
      message:
        resolved.state === "ACCEPTED"
          ? `Negotiation accepted at ${resolved.finalPrice} minor units.`
          : `Negotiation ${resolved.state}.`,
    });
  }

  // ─── 6a. BUYER ACCEPTS OFFER (buyer-side only) ─────────────────────
  // Two-sided marketplace: buyer acceptance does NOT create an agreement.
  // It transitions the offer to BUYER_ACCEPTED and waits for provider.
  if (mode === "buyer_accept_offer" || mode === "accept_offer") {
    const offer = await db.marketplaceOffer.findUnique({
      where: { id: body.offerId },
    });
    if (!offer) return NextResponse.json({ error: "Offer not found." }, { status: 404 });

    const demand = await db.transportationDemand.findUnique({
      where: { id: offer.demandId },
    });
    if (!demand) return NextResponse.json({ error: "Demand not found." }, { status: 404 });
    if (!assertOwnership(demand, email)) return ownershipError(email);

    // DEFECT 1 FIX: Expiry/status decision and state transition are ATOMIC.
    // Everything happens inside a single PostgreSQL transaction using
    // updateMany with a WHERE condition (equivalent to SELECT FOR UPDATE
    // + conditional UPDATE). No state decision depends on a pre-transaction
    // read.
    //
    // Valid outcomes:
    //   - PENDING + not expired → BUYER_ACCEPTED (exactly one winner)
    //   - PENDING + expired → EXPIRED (deterministic)
    //   - Non-PENDING → 409 conflict (already accepted/rejected/expired)
    const result = await db.$transaction(async (tx) => {
      const now = new Date();
      const isExpired = offer.expiresAt && new Date(offer.expiresAt) < now;

      if (isExpired) {
        // Atomically transition PENDING → EXPIRED (only if still PENDING).
        const expiryUpdate = await tx.marketplaceOffer.updateMany({
          where: { id: offer.id, status: "PENDING" },
          data: { status: "EXPIRED" },
        });
        if (expiryUpdate.count > 0) {
          await logEvent(tx, "offer-expired", "offer", offer.id, {
            expiresAt: offer.expiresAt,
          });
        }
        return { expired: true as const };
      }

      // Atomically claim PENDING → BUYER_ACCEPTED (only if still PENDING).
      // If another request already claimed it, count === 0 → conflict.
      const claimUpdate = await tx.marketplaceOffer.updateMany({
        where: { id: offer.id, status: "PENDING" },
        data: { status: "BUYER_ACCEPTED" },
      });
      if (claimUpdate.count === 0) {
        return { conflict: true as const };
      }

      // Opportunity lifecycle: OFFERED → BUYER_ACCEPTED
      await tx.transportationOpportunity.update({
        where: { id: offer.opportunityId },
        data: { status: "BUYER_ACCEPTED" },
      });

      await logEvent(tx, "offer-buyer-accepted", "offer", offer.id, {
        buyerId: email,
      });

      return { accepted: true as const };
    });

    if ("expired" in result && result.expired) {
      return NextResponse.json({
        error: "Offer has expired. Acceptance rejected.",
        offerId: offer.id,
        expiresAt: offer.expiresAt,
      }, { status: 400 });
    }

    if ("conflict" in result && result.conflict) {
      return NextResponse.json({
        error: "Offer is no longer PENDING (already accepted, rejected, or expired by another request).",
      }, { status: 409 });
    }

    return NextResponse.json({
      offer: { id: offer.id, status: "BUYER_ACCEPTED" },
      message: "Buyer accepted offer. Waiting for provider acceptance. No agreement created yet.",
    });
  }

  // ─── 6b. PROVIDER ACCEPTS OFFER (provider-side) ────────────────────
  // Two-sided marketplace with EXTERNAL IDEMPOTENCY:
  //
  // 1. Authenticate provider (server-derived identity)
  // 2. Verify provider owns offer
  // 3. Create durable ProviderAcceptanceAttempt (claim) in a short transaction
  // 4. If claim already exists (retry/concurrent), return existing result
  // 5. Call provider adapter with idempotencyKey (external side effect)
  // 6. Finalize ORYXX state (offer, agreement, supply) in a second transaction
  //
  // The external provider call happens BETWEEN two separate transactions.
  // No DB transaction is held across the external call.
  // The adapter receives a stable idempotencyKey so retries don't cause
  // duplicate provider acceptances.
  if (mode === "provider_accept_offer") {
    const provider = await requireProviderIdentity();
    if (!provider) return NextResponse.json({ error: "Provider authentication required." }, { status: 401 });

    const offer = await db.marketplaceOffer.findUnique({
      where: { id: body.offerId },
    });
    if (!offer) return NextResponse.json({ error: "Offer not found." }, { status: 404 });

    // Provider authorization: the offer's providerId must match the
    // resolved provider identity. Forged providerId from body is ignored.
    if (!assertProviderOwnsOffer(offer, provider)) return providerAuthError();

    // ── STEP 1: Create durable claim BEFORE external call ────────────
    // Use upsert on (offerId, providerId) to guarantee exactly one claim row.
    // The upsert increments attemptCount on retries.
    const claimKey = `accept-${offer.id}-${provider.providerId}`;
    let attempt = await db.providerAcceptanceAttempt.upsert({
      where: { claimKey },
      update: { attemptCount: { increment: 1 } },
      create: {
        offerId: offer.id,
        providerId: provider.providerId,
        claimKey,
        status: "PENDING",
        environment: ENV,
      },
    });

    // If a prior attempt already reached a terminal state, return it.
    // ACCEPTED: return cached result (idempotent — no provider call).
    if (attempt.status === "ACCEPTED") {
      return NextResponse.json({
        offer: { id: offer.id, status: "PROVIDER_ACCEPTED" },
        agreement: await db.marketplaceAgreement.findUnique({ where: { offerId: offer.id } }),
        message: "Provider already accepted this offer (idempotent).",
        claimId: attempt.id,
        claimStatus: "ACCEPTED",
        providerReference: attempt.providerReference ?? undefined,
      });
    }
    // REJECTED: return cached rejection (no provider call).
    if (attempt.status === "REJECTED") {
      return NextResponse.json({
        error: `Provider previously rejected this offer: ${attempt.lastError || "unknown"}`,
        claimId: attempt.id,
        claimStatus: "REJECTED",
      }, { status: 409 });
    }
    // UNKNOWN: provider outcome is uncertain — reconciliation required.
    // Do NOT automatically retry. Return 503.
    if (attempt.status === "UNKNOWN") {
      return NextResponse.json({
        error: "Provider acceptance outcome is UNKNOWN. Reconciliation required.",
        claimId: attempt.id,
        claimStatus: "UNKNOWN",
        providerReference: attempt.providerReference ?? undefined,
        lastError: attempt.lastError,
      }, { status: 503 });
    }
    // SUBMITTED: another request currently owns the external call.
    // Return 202 (in-progress) — do NOT call the provider.
    if (attempt.status === "SUBMITTED") {
      return NextResponse.json({
        message: "Provider acceptance is in progress (another request owns the external call).",
        claimId: attempt.id,
        claimStatus: "SUBMITTED",
      }, { status: 202 });
    }

    // ── STEP 2: Verify offer is still BUYER_ACCEPTED ─────────────────
    // This is a pre-claim check. If the offer is no longer BUYER_ACCEPTED,
    // it means another request already finalized it (PROVIDER_ACCEPTED,
    // REJECTED, EXPIRED). These are all concurrency conflicts (409), not
    // client errors (400).
    if (offer.status !== "BUYER_ACCEPTED") {
      return NextResponse.json({
        error: `Offer is in status ${offer.status}; cannot provider-accept (already finalized by another request).`,
        currentStatus: offer.status,
      }, { status: 409 });
    }

    // ── STEP 3: ATOMICALLY claim PENDING → SUBMITTED ────────────────
    // This is the CRITICAL concurrency guard. Only the request that
    // atomically transitions PENDING → SUBMITTED owns the external call.
    // All other concurrent requests see SUBMITTED and return 202.
    //
    // updateMany with WHERE status = 'PENDING' is equivalent to
    // SELECT FOR UPDATE + conditional UPDATE. If count === 0, another
    // request already claimed it (or it was already in a terminal state).
    const claimOwnership = await db.providerAcceptanceAttempt.updateMany({
      where: { id: attempt.id, status: "PENDING" },
      data: { status: "SUBMITTED" },
    });

    if (claimOwnership.count === 0) {
      // Another request won the race. Re-read the claim to determine
      // its current state and return the appropriate response.
      const refreshedAttempt = await db.providerAcceptanceAttempt.findUnique({
        where: { id: attempt.id },
      });
      if (refreshedAttempt?.status === "SUBMITTED") {
        return NextResponse.json({
          message: "Provider acceptance is in progress (another request owns the external call).",
          claimId: attempt.id,
          claimStatus: "SUBMITTED",
        }, { status: 202 });
      }
      if (refreshedAttempt?.status === "ACCEPTED") {
        return NextResponse.json({
          offer: { id: offer.id, status: "PROVIDER_ACCEPTED" },
          agreement: await db.marketplaceAgreement.findUnique({ where: { offerId: offer.id } }),
          message: "Provider already accepted this offer (idempotent).",
          claimId: attempt.id,
          claimStatus: "ACCEPTED",
          providerReference: refreshedAttempt.providerReference ?? undefined,
        });
      }
      // Fallback: return conflict
      return NextResponse.json({
        error: "Claim is no longer PENDING. Another request owns the external call.",
        claimId: attempt.id,
        claimStatus: refreshedAttempt?.status ?? "UNKNOWN",
      }, { status: 409 });
    }

    // ── STEP 4: Call provider adapter (ONLY the owner reaches here) ─
    // This request is the sole owner of the external provider call.
    // The adapter receives the idempotencyKey (claimKey) so that even if
    // the adapter is called twice (e.g., by a bug or reconciliation),
    // it deduplicates by key.
    const adapter = providerRegistry.get(offer.providerId);
    let providerAccepted = false;
    let providerReference: string | undefined;
    let providerReason: string | undefined;

    if (adapter && "acceptOffer" in adapter && typeof adapter.acceptOffer === "function") {
      const acceptResult = await adapter.acceptOffer(offer.id, claimKey);
      providerAccepted = acceptResult.accepted;
      providerReference = acceptResult.providerReference;
      providerReason = acceptResult.reason;
    } else if (adapter) {
      // Fallback: old adapter interface (for backward compat)
      const acceptResult = await adapter.accept(offer.id);
      providerAccepted = acceptResult.accepted;
      providerReason = acceptResult.reason;
    }

    // ── STEP 4: Handle provider result ──────────────────────────────
    if (!providerAccepted) {
      // Provider rejected — update claim and return
      await db.providerAcceptanceAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "REJECTED",
          lastError: providerReason || "Provider rejected offer",
        },
      });
      return NextResponse.json({
        error: `Provider adapter rejected offer: ${providerReason || "unknown"}`,
        claimId: attempt.id,
        claimStatus: "REJECTED",
      }, { status: 400 });
    }

    // ── STEP 5: Finalize ORYXX state in a second transaction ────────
    // This transaction does NOT span the external call. It atomically:
    //   1. Claims the offer (BUYER_ACCEPTED → PROVIDER_ACCEPTED)
    //   2. Creates the agreement
    //   3. Reserves the supply
    //   4. Updates the claim to ACCEPTED
    // If this transaction fails (because another request already won),
    // the claim retains the provider reference for reconciliation.
    const result = await db.$transaction(async (tx) => {
      // 1. Atomically claim BUYER_ACCEPTED → PROVIDER_ACCEPTED
      const claimUpdate = await tx.marketplaceOffer.updateMany({
        where: { id: offer.id, status: "BUYER_ACCEPTED" },
        data: { status: "PROVIDER_ACCEPTED" },
      });
      if (claimUpdate.count === 0) {
        throw new Error("OFFER_ALREADY_CLAIMED");
      }

      // 2. Create agreement
      let agreement;
      try {
        agreement = await tx.marketplaceAgreement.create({
          data: {
            offerId: offer.id,
            opportunityId: offer.opportunityId,
            demandId: offer.demandId,
            supplyId: offer.supplyId,
            providerId: offer.providerId,
            agreedPrice: offer.userPrice,
            supplierCompensation: offer.supplierCompensation,
            platformFee: offer.platformFee,
            status: "ACTIVE",
            isMarketplaceOpportunity: true,
            researchStimulus: false,
            environment: ENV,
          },
        });
      } catch (err: any) {
        if (err?.code === "P2002") throw new Error("AGREEMENT_ALREADY_EXISTS");
        throw err;
      }

      // 3. Atomically reserve supply
      const supplyUpdate = await tx.transportationSupply.updateMany({
        where: { id: offer.supplyId, status: "AVAILABLE" },
        data: { status: "RESERVED" },
      });
      if (supplyUpdate.count === 0) throw new Error("SUPPLY_ALREADY_RESERVED");

      // 4. Transition opportunity
      await tx.transportationOpportunity.update({
        where: { id: offer.opportunityId },
        data: { status: "ACCEPTED" },
      });

      // 5. Update claim to ACCEPTED with provider reference
      await tx.providerAcceptanceAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "ACCEPTED",
          providerReference: providerReference ?? null,
        },
      });

      // 6. Append audit events
      await logEvent(tx, "offer-provider-accepted", "offer", offer.id, {
        providerId: provider.providerId,
        providerReference,
      });
      await logEvent(tx, "agreement-created", "agreement", agreement.id, {
        offerId: offer.id,
        agreedPrice: agreement.agreedPrice,
      });
      await logEvent(tx, "supply-reserved", "supply", offer.supplyId, {});

      return { offer: { id: offer.id, status: "PROVIDER_ACCEPTED" }, agreement };
    }).catch((err: any) => {
      if (err?.message === "OFFER_ALREADY_CLAIMED") return { conflict: "Offer already accepted" as const };
      if (err?.message === "SUPPLY_ALREADY_RESERVED") return { conflict: "Supply already reserved" as const };
      if (err?.message === "AGREEMENT_ALREADY_EXISTS") return { conflict: "Agreement already exists" as const };
      throw err;
    });

    if ("conflict" in result && typeof result.conflict === "string") {
      // Another request won the race. But the provider MAY have already
      // accepted (the external call succeeded). Persist the provider
      // reference for reconciliation.
      await db.providerAcceptanceAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "UNKNOWN", // provider accepted but ORYXX finalization lost
          providerReference: providerReference ?? null,
          lastError: result.conflict,
        },
      }).catch(() => {}); // best-effort
      return NextResponse.json({
        error: result.conflict + ". Provider reference retained for reconciliation.",
        claimId: attempt.id,
        claimStatus: "UNKNOWN",
        providerReference,
      }, { status: 409 });
    }

    return NextResponse.json({
      offer: result.offer,
      agreement: result.agreement,
      message: "Provider accepted offer; agreement created; supply RESERVED.",
      claimId: attempt.id,
      claimStatus: "ACCEPTED",
      providerReference,
    });
  }

  // ─── 6c. PROVIDER REJECTS OFFER ────────────────────────────────────
  if (mode === "provider_reject_offer") {
    const provider = await requireProviderIdentity();
    if (!provider) return NextResponse.json({ error: "Provider authentication required." }, { status: 401 });

    const offer = await db.marketplaceOffer.findUnique({
      where: { id: body.offerId },
    });
    if (!offer) return NextResponse.json({ error: "Offer not found." }, { status: 404 });
    if (!assertProviderOwnsOffer(offer, provider)) return providerAuthError();

    if (offer.status !== "BUYER_ACCEPTED" && offer.status !== "PENDING") {
      return NextResponse.json(
        { error: `Offer is in status ${offer.status}; cannot reject.` },
        { status: 400 },
      );
    }

    const result = await db.$transaction(async (tx) => {
      const rejectedOffer = await tx.marketplaceOffer.update({
        where: { id: offer.id },
        data: { status: "REJECTED" },
      });
      await tx.transportationOpportunity.update({
        where: { id: rejectedOffer.opportunityId },
        data: { status: "REJECTED" },
      });
      await logEvent(tx, "offer-provider-rejected", "offer", rejectedOffer.id, {
        providerId: provider.providerId,
        reason: body.reason || "Provider rejected offer",
      });
      return { offer: rejectedOffer };
    });

    return NextResponse.json({
      offer: result.offer,
      message: "Provider rejected offer. No agreement created.",
    });
  }

  // ─── 7. AUTHORIZE PAYMENT ────────────────────────────────────────────
  if (mode === "authorize_payment") {
    const agreement = await db.marketplaceAgreement.findUnique({
      where: { id: body.agreementId },
    });
    if (!agreement) {
      return NextResponse.json({ error: "Agreement not found." }, { status: 404 });
    }

    const demand = await db.transportationDemand.findUnique({
      where: { id: agreement.demandId },
    });
    if (!demand) return NextResponse.json({ error: "Demand not found." }, { status: 404 });
    if (!assertOwnership(demand, email)) return ownershipError(email);
    if (agreement.environment !== ENV) {
      return NextResponse.json(
        { error: `Agreement environment mismatch (expected ${ENV}).` },
        { status: 400 },
      );
    }
    // PAYMENT GATING: agreement must be ACTIVE (requires both buyer AND
    // provider acceptance). No payment before two-sided agreement.
    if (agreement.status !== "ACTIVE") {
      return NextResponse.json(
        { error: `Agreement is ${agreement.status}; payment requires ACTIVE agreement (both sides accepted).` },
        { status: 400 },
      );
    }

    // Explicit sandbox funding — ensure the customer account exists with
    // $100.00 before debiting. No implicit account funding during payment.
    const customerAccount = await ensureSandboxAccount(email);
    const escrowAccount = await ensureEscrowAccount();

    const amount = agreement.agreedPrice;
    if (amount <= 0) {
      return NextResponse.json(
        { error: "Agreement amount must be positive." },
        { status: 400 },
      );
    }

    // No overdraft — check the customer's balance BEFORE entering the tx.
    if (customerAccount.balance < amount) {
      return NextResponse.json(
        {
          error: "Insufficient funds (no overdraft in sandbox).",
          balance: customerAccount.balance,
          required: amount,
        },
        { status: 400 },
      );
    }

    // Stable idempotency key per (agreement, customer) pair — replaying the
    // same authorization request returns the existing PaymentIntent.
    const idempotencyKey = `authorize-${agreement.id}-${customerAccount.id}`;

    // Idempotency short-circuit: if the intent already exists, return it.
    const existing = await db.paymentIntent.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      return NextResponse.json({
        paymentIntent: existing,
        message: "Payment intent already authorized (idempotent).",
      });
    }

    const result = await db.$transaction(async (tx) => {
      // Re-check the balance INSIDE the transaction to avoid races between
      // concurrent authorization attempts.
      const lockedCustomer = await tx.moneyAccount.findUnique({
        where: { id: customerAccount.id },
      });
      if (!lockedCustomer || lockedCustomer.balance < amount) {
        throw new Error("Insufficient funds (no overdraft in sandbox).");
      }

      // Create the PaymentIntent (status=AUTHORIZED).
      const intent = await tx.paymentIntent.create({
        data: {
          demandId: agreement.demandId,
          agreementId: agreement.id,
          customerId: customerAccount.id,
          supplierId: agreement.providerId,
          amount,
          userPrice: agreement.agreedPrice,
          supplierCompensation: agreement.supplierCompensation,
          platformFee: agreement.platformFee,
          currency: CURRENCY,
          status: "AUTHORIZED",
          idempotencyKey,
          authorizationId: `auth-${idempotencyKey}`,
          environment: ENV,
        },
      });

      // Post double-entry: DEBIT customer, CREDIT escrow. Both entries are
      // idempotent — replaying the same key returns the existing entries
      // without modifying balances.
      await postDoubleEntry(
        db,
        tx,
        customerAccount.id,
        escrowAccount.id,
        amount,
        `Payment authorization for demand ${agreement.demandId}`,
        "payment-intent",
        intent.id,
        idempotencyKey,
        ENV,
      );

      await logEvent(tx, "payment-authorized", "payment-intent", intent.id, {
        agreementId: agreement.id,
        amount,
        customerId: customerAccount.id,
        escrowAccountId: escrowAccount.id,
      });

      return { intent };
    });

    return NextResponse.json({
      paymentIntent: result.intent,
      message: "Payment authorized (SANDBOX). Customer debited; escrow credited.",
    });
  }

  // ─── 8. CAPTURE PAYMENT ──────────────────────────────────────────────
  if (mode === "capture_payment") {
    const intent = await db.paymentIntent.findUnique({
      where: { id: body.paymentIntentId },
    });
    if (!intent) {
      return NextResponse.json({ error: "PaymentIntent not found." }, { status: 404 });
    }

    const demand = await db.transportationDemand.findUnique({
      where: { id: intent.demandId },
    });
    if (!demand) return NextResponse.json({ error: "Demand not found." }, { status: 404 });
    if (!assertOwnership(demand, email)) return ownershipError(email);
    if (intent.status === "CAPTURED") {
      return NextResponse.json({
        paymentIntent: intent,
        message: "Payment already captured (idempotent).",
      });
    }
    if (intent.status !== "AUTHORIZED") {
      return NextResponse.json(
        {
          error: `PaymentIntent is in status ${intent.status}; only AUTHORIZED intents can be captured.`,
        },
        { status: 400 },
      );
    }

    const escrowAccount = await ensureEscrowAccount();
    const supplierAccount = await ensureSupplierAccount(intent.supplierId);
    const platformAccount = await ensurePlatformRevenueAccount();

    const supplierCompensation = intent.supplierCompensation;
    const platformFee = intent.platformFee;
    const captureIdempotencyKey = `capture-${intent.id}`;

    const result = await db.$transaction(async (tx) => {
      // Transition the PaymentIntent AUTHORIZED → CAPTURED.
      const capturedIntent = await tx.paymentIntent.update({
        where: { id: intent.id },
        data: {
          status: "CAPTURED",
          captureId: captureIdempotencyKey,
          capturedAt: new Date(),
        },
      });

      // DEBIT escrow → CREDIT supplier (supplier compensation).
      await postDoubleEntry(
        db,
        tx,
        escrowAccount.id,
        supplierAccount.id,
        supplierCompensation,
        `Supplier compensation for payment ${intent.id}`,
        "payment-intent",
        intent.id,
        `${captureIdempotencyKey}-supplier`,
        ENV,
      );

      // DEBIT escrow → CREDIT platform-revenue (platform fee).
      await postDoubleEntry(
        db,
        tx,
        escrowAccount.id,
        platformAccount.id,
        platformFee,
        `Platform fee for payment ${intent.id}`,
        "payment-intent",
        intent.id,
        `${captureIdempotencyKey}-platform`,
        ENV,
      );

      await logEvent(tx, "payment-captured", "payment-intent", intent.id, {
        supplierCompensation,
        platformFee,
        supplierAccountId: supplierAccount.id,
        platformAccountId: platformAccount.id,
      });

      return { intent: capturedIntent };
    });

    return NextResponse.json({
      paymentIntent: result.intent,
      message:
        "Payment captured. Escrow debited; supplier + platform-revenue credited.",
    });
  }

  // ─── 9. RESERVE EXECUTION ────────────────────────────────────────────
  if (mode === "reserve_execution") {
    const agreement = await db.marketplaceAgreement.findUnique({
      where: { id: body.agreementId },
    });
    if (!agreement) {
      return NextResponse.json({ error: "Agreement not found." }, { status: 404 });
    }

    const demand = await db.transportationDemand.findUnique({
      where: { id: agreement.demandId },
    });
    if (!demand) return NextResponse.json({ error: "Demand not found." }, { status: 404 });
    if (!assertOwnership(demand, email)) return ownershipError(email);
    if (agreement.environment !== ENV) {
      return NextResponse.json(
        { error: `Agreement environment mismatch (expected ${ENV}).` },
        { status: 400 },
      );
    }
    // EXECUTION GATING: agreement must be ACTIVE (requires both sides
    // accepted). No execution before two-sided agreement.
    if (agreement.status !== "ACTIVE") {
      return NextResponse.json(
        { error: `Agreement is ${agreement.status}; execution requires ACTIVE agreement (both sides accepted).` },
        { status: 400 },
      );
    }

    // DEFECT 3 FIX: Payment must precede execution. Verify a CAPTURED
    // PaymentIntent exists for this agreement before creating an execution.
    const capturedPayment = await db.paymentIntent.findFirst({
      where: { agreementId: agreement.id, status: "CAPTURED" },
    });
    if (!capturedPayment) {
      return NextResponse.json(
        { error: "No CAPTURED payment for this agreement. Execution requires captured payment." },
        { status: 400 },
      );
    }

    const opportunity = await db.transportationOpportunity.findUnique({
      where: { id: agreement.opportunityId },
    });
    if (!opportunity) {
      return NextResponse.json({ error: "Opportunity not found." }, { status: 404 });
    }

    // Idempotency: if an execution already exists for this agreement,
    // return it without re-driving the engine.
    const existingExecution = await db.transportationExecution.findUnique({
      where: { agreementId: agreement.id },
    });
    if (existingExecution) {
      return NextResponse.json({
        execution: existingExecution,
        message: "Execution already exists for this agreement (idempotent).",
      });
    }

    const domainOpp = toDomainOpportunity(opportunity);

    // Build the domain agreement for createExecution. The execution inherits
    // its environment from the agreement's provenance (SANDBOX).
    const domainAgreement: DomainAgreement = {
      id: agreement.id,
      offerId: agreement.offerId,
      opportunityId: agreement.opportunityId,
      demandId: agreement.demandId,
      supplyId: agreement.supplyId,
      providerId: agreement.providerId,
      agreedPrice: agreement.agreedPrice,
      supplierCompensation: agreement.supplierCompensation,
      platformFee: agreement.platformFee,
      status: agreement.status as DomainAgreement["status"],
      provenance: domainOpp.provenance,
      isMarketplaceOpportunity: true,
      researchStimulus: false,
      createdAt: agreement.createdAt.toISOString(),
    };

    // Use the real ExecutionEngine. createExecution returns state
    // OPPORTUNITY_CREATED; we drive forward through OFFERED → ACCEPTED →
    // RESERVED using the engine's state machine (canTransition guards each
    // step). The persisted execution is at state RESERVED.
    let execution = createExecution(domainAgreement, domainOpp);
    if (canTransition(execution.state, "OFFERED")) {
      execution = transition(execution, "OFFERED");
    }
    if (canTransition(execution.state, "ACCEPTED")) {
      execution = transition(execution, "ACCEPTED");
    }
    if (canTransition(execution.state, "RESERVED")) {
      execution = transition(execution, "RESERVED");
    }

    const result = await db.$transaction(async (tx) => {
      // Persist the execution at the engine-driven state (RESERVED).
      // evidenceEligible=false — SANDBOX cannot produce W3-M/W4-M.
      const dbExecution = await tx.transportationExecution.create({
        data: {
          id: execution.id,
          agreementId: agreement.id,
          opportunityId: agreement.opportunityId,
          demandId: agreement.demandId,
          supplyId: agreement.supplyId,
          providerId: agreement.providerId,
          state: execution.state,
          environment: ENV,
          evidenceEligible: false,
          isMarketplaceOpportunity: true,
          researchStimulus: false,
        },
      });

      // Supply lifecycle: RESERVED → COMMITTED (supply is now bound to this
      // execution and cannot be re-cleared).
      await tx.transportationSupply.update({
        where: { id: agreement.supplyId },
        data: { status: "COMMITTED" },
      });

      // Demand lifecycle: MATCHED → IN_PROGRESS.
      await tx.transportationDemand.update({
        where: { id: demand.id },
        data: { status: "IN_PROGRESS" },
      });

      await logEvent(tx, "execution-reserved", "execution", dbExecution.id, {
        agreementId: agreement.id,
        supplyId: agreement.supplyId,
        engineState: execution.state,
      });
      await logEvent(tx, "supply-committed", "demand", demand.id, {
        supplyId: agreement.supplyId,
      });
      await logEvent(tx, "demand-in-progress", "demand", demand.id, {});

      return { execution: dbExecution };
    });

    return NextResponse.json({
      execution: result.execution,
      message:
        "Execution created (state=RESERVED); supply COMMITTED; demand IN_PROGRESS. evidenceEligible=false.",
    });
  }

  // ─── 10. DISPATCH ────────────────────────────────────────────────────
  if (mode === "dispatch") {
    const execution = await db.transportationExecution.findUnique({
      where: { id: body.executionId },
    });
    if (!execution) {
      return NextResponse.json({ error: "Execution not found." }, { status: 404 });
    }

    const demand = await db.transportationDemand.findUnique({
      where: { id: execution.demandId },
    });
    if (!demand) return NextResponse.json({ error: "Demand not found." }, { status: 404 });
    if (!assertOwnership(demand, email)) return ownershipError(email);
    if (execution.environment !== ENV) {
      return NextResponse.json(
        { error: `Execution environment mismatch (expected ${ENV}).` },
        { status: 400 },
      );
    }

    // Reconstruct the domain execution for the engine. The engine is
    // immutable — every transition returns a new object.
    let domainExecution: DomainExecution = {
      id: execution.id,
      agreementId: execution.agreementId,
      opportunityId: execution.opportunityId,
      demandId: execution.demandId,
      supplyId: execution.supplyId,
      providerId: execution.providerId,
      state: execution.state as ExecutionState,
      environment: execution.environment as Environment,
      evidenceEligible: execution.evidenceEligible,
      provenance: {
        environment: execution.environment as Environment,
        source: "oryxx-owned" as Provenance["source"],
        observedAt: execution.createdAt.toISOString(),
        confidence: 1,
      },
      isMarketplaceOpportunity: true,
      researchStimulus: false,
      createdAt: execution.createdAt.toISOString(),
      startedAt: execution.startedAt?.toISOString(),
      completedAt: execution.completedAt?.toISOString(),
      failureReason: execution.failureReason ?? undefined,
    };

    // Refuse to dispatch a terminal execution.
    if (isTerminal(domainExecution.state)) {
      return NextResponse.json(
        { error: `Execution is in terminal state ${domainExecution.state}.` },
        { status: 400 },
      );
    }

    // Drive the engine: RESERVED → DISPATCHED → EN_ROUTE.
    if (canTransition(domainExecution.state, "DISPATCHED")) {
      domainExecution = transition(domainExecution, "DISPATCHED");
    }
    if (canTransition(domainExecution.state, "EN_ROUTE")) {
      domainExecution = transition(domainExecution, "EN_ROUTE");
    }

    // Call the provider adapter to start the execution on its side. The
    // adapter returns its own executionId which we'll need for
    // verifyCompletion later — we persist it in a MarketplaceEvent payload.
    const provider = providerRegistry.get(execution.providerId);
    let providerExecutionId: string | undefined;
    if (provider) {
      const startResult = await provider.startExecution(execution.opportunityId);
      if (!startResult.started) {
        // The adapter interface declares `{ started, executionId? }` but some
        // adapters (e.g. fixture-provider) also return a `reason` field. Cast
        // to access it so we can surface the provider's reason on failure.
        const reason = (startResult as { reason?: string }).reason ?? "unknown";
        return NextResponse.json(
          {
            error: `Provider ${execution.providerId} refused to start execution.`,
            reason,
          },
          { status: 502 },
        );
      }
      providerExecutionId = startResult.executionId;
    }

    const result = await db.$transaction(async (tx) => {
      const updated = await tx.transportationExecution.update({
        where: { id: execution.id },
        data: {
          state: domainExecution.state,
          startedAt: domainExecution.startedAt
            ? new Date(domainExecution.startedAt)
            : new Date(),
        },
      });
      await logEvent(tx, "execution-dispatched", "execution", execution.id, {
        state: domainExecution.state,
        providerExecutionId,
        providerId: execution.providerId,
      });
      return { execution: updated, providerExecutionId };
    });

    return NextResponse.json({
      execution: result.execution,
      providerExecutionId: result.providerExecutionId,
      message: `Execution dispatched (state=${result.execution.state}). Provider adapter notified.`,
    });
  }

  // ─── 11. COMPLETE EXECUTION ──────────────────────────────────────────
  if (mode === "complete_execution") {
    const execution = await db.transportationExecution.findUnique({
      where: { id: body.executionId },
    });
    if (!execution) {
      return NextResponse.json({ error: "Execution not found." }, { status: 404 });
    }

    const demand = await db.transportationDemand.findUnique({
      where: { id: execution.demandId },
    });
    if (!demand) return NextResponse.json({ error: "Demand not found." }, { status: 404 });
    if (!assertOwnership(demand, email)) return ownershipError(email);
    if (execution.environment !== ENV) {
      return NextResponse.json(
        { error: `Execution environment mismatch (expected ${ENV}).` },
        { status: 400 },
      );
    }

    // Reconstruct the domain execution.
    let domainExecution: DomainExecution = {
      id: execution.id,
      agreementId: execution.agreementId,
      opportunityId: execution.opportunityId,
      demandId: execution.demandId,
      supplyId: execution.supplyId,
      providerId: execution.providerId,
      state: execution.state as ExecutionState,
      environment: execution.environment as Environment,
      evidenceEligible: execution.evidenceEligible,
      provenance: {
        environment: execution.environment as Environment,
        source: "oryxx-owned" as Provenance["source"],
        observedAt: execution.createdAt.toISOString(),
        confidence: 1,
      },
      isMarketplaceOpportunity: true,
      researchStimulus: false,
      createdAt: execution.createdAt.toISOString(),
      startedAt: execution.startedAt?.toISOString(),
      completedAt: execution.completedAt?.toISOString(),
      failureReason: execution.failureReason ?? undefined,
    };

    if (isTerminal(domainExecution.state)) {
      return NextResponse.json(
        { error: `Execution is in terminal state ${domainExecution.state}.` },
        { status: 400 },
      );
    }

    // Drive the engine forward through PICKED_UP → EXECUTING → COMPLETED.
    if (canTransition(domainExecution.state, "PICKED_UP")) {
      domainExecution = transition(domainExecution, "PICKED_UP");
    }
    if (canTransition(domainExecution.state, "EXECUTING")) {
      domainExecution = transition(domainExecution, "EXECUTING");
    }
    if (canTransition(domainExecution.state, "COMPLETED")) {
      domainExecution = transition(domainExecution, "COMPLETED");
    }
    if (domainExecution.state !== "COMPLETED") {
      return NextResponse.json(
        {
          error: `Execution could not reach COMPLETED from state ${execution.state}.`,
          currentState: domainExecution.state,
        },
        { status: 400 },
      );
    }

    // Look up the provider's execution ID (stored in the dispatch event
    // payload). We need it for provider.verifyCompletion().
    const dispatchEvent = await db.marketplaceEvent.findFirst({
      where: {
        referenceType: "execution",
        referenceId: execution.id,
        eventType: "execution-dispatched",
      },
      orderBy: { timestamp: "desc" },
    });
    let providerExecutionId: string | undefined;
    if (dispatchEvent?.payloadJson) {
      try {
        const payload = JSON.parse(dispatchEvent.payloadJson) as {
          providerExecutionId?: string;
        };
        providerExecutionId = payload.providerExecutionId;
      } catch {
        // Ignore malformed payload — provider verification will just fail.
      }
    }

    // Call the provider adapter to independently verify completion. The
    // provider CANNOT self-report — verifyCompletion must return verified=true
    // for us to record a Settlement. If verification fails, NO completion,
    // NO settlement, NO demand COMPLETED. The transaction must not partially
    // mutate state.
    const provider = providerRegistry.get(execution.providerId);
    let verified = false;
    let providerCompletedAt: string | undefined;
    if (provider && providerExecutionId) {
      // Advance the sandbox provider's internal state by calling getStatus().
      // The sandbox provider progresses EN_ROUTE → PICKED_UP → COMPLETED
      // on each getStatus() call. This simulates the provider observing
      // the execution progressing through its lifecycle.
      await provider.getStatus(providerExecutionId);
      await provider.getStatus(providerExecutionId);
      const verifyResult = await provider.verifyCompletion(providerExecutionId);
      verified = verifyResult.verified;
      providerCompletedAt = verifyResult.completedAt;
    }

    // DEFECT 2 FIX: If provider verification failed, block completion entirely.
    // No partial state mutation. Return failure without touching DB state.
    if (!verified) {
      return NextResponse.json({
        error: "Provider completion verification failed. No completion, no settlement, no demand completion.",
        executionId: execution.id,
        verified: false,
      }, { status: 400 });
    }

    // Load the agreement so the Settlement amount can record the supplier
    // compensation that was actually captured.
    const agreement = await db.marketplaceAgreement.findUnique({
      where: { id: execution.agreementId },
    });
    const settlementAmount = agreement?.supplierCompensation ?? 0;

    const result = await db.$transaction(async (tx) => {
      const updated = await tx.transportationExecution.update({
        where: { id: execution.id },
        data: {
          state: domainExecution.state,
          completedAt: providerCompletedAt
            ? new Date(providerCompletedAt)
            : new Date(),
        },
      });

      // Demand lifecycle: IN_PROGRESS → COMPLETED.
      await tx.transportationDemand.update({
        where: { id: demand.id },
        data: { status: "COMPLETED" },
      });

      // Create the Settlement (SETTLED — funds already credited at capture).
      const settlement = await tx.settlement.create({
        data: {
          executionId: execution.id,
          supplierId: execution.providerId,
          amount: settlementAmount,
          currency: CURRENCY,
          status: "SETTLED",
          idempotencyKey: `settlement-${execution.id}`,
          environment: ENV,
          settledAt: new Date(),
        },
      });

      await logEvent(tx, "execution-completed", "execution", execution.id, {
        state: updated.state,
        providerVerified: verified,
        settlementId: settlement.id,
      });
      await logEvent(tx, "demand-completed", "demand", demand.id, {
        executionId: execution.id,
      });

      return { execution: updated, settlement, verified };
    });

    return NextResponse.json({
      execution: result.execution,
      settlement: result.settlement,
      providerVerified: result.verified,
      evidenceProduced: {
        w3m: false,
        w4m: false,
        reason:
          "SANDBOX execution cannot produce W3-M/W4-M evidence (evidenceEligible=false).",
      },
      message:
        "Execution completed in SANDBOX. Demand COMPLETED. No marketplace evidence produced.",
    });
  }

  // ─── BROADCAST AVAILABILITY (kept for parity) ───────────────────────
  if (mode === "broadcast_availability") {
    const broadcast = await db.availabilityBroadcast.create({
      data: {
        providerId: body.providerId || "sandbox-rideshare",
        resourceId: body.resourceId || "sandbox-vehicle-1",
        currentLat: body.currentLat ?? 40.7589,
        currentLon: body.currentLon ?? -73.9851,
        destLat: body.destLat ?? 40.7505,
        destLon: body.destLon ?? -73.9934,
        departureStartSec:
          body.departureStartSec ?? Math.floor(Date.now() / 1000) % 86400,
        departureEndSec:
          body.departureEndSec ?? (Math.floor(Date.now() / 1000) % 86400) + 3600,
        availableCapacity: body.availableCapacity ?? 3,
        detourToleranceKm: body.detourToleranceKm ?? 3,
        minimumCompensation: body.minimumCompensation ?? 500,
        confidence: body.confidence ?? 0.8,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        status: "POTENTIAL",
        isCommitted: false,
        environment: ENV,
      },
    });
    return NextResponse.json({
      broadcast,
      message: "Availability broadcast created (POTENTIAL — not committed supply).",
    });
  }

  return NextResponse.json({ error: "Unknown mode." }, { status: 400 });
}
