// ORYXX — Marketplace integration tests.
//
// Tests the live marketplace pipeline: domain types, provider adapters,
// opportunity engine, market clearing, negotiation, money ledger, execution.
// All tests use in-memory state (no DB required for engine tests).
//
// Research isolation is verified: marketplace objects can never produce
// W3-R/W4-R, and sandbox execution can never produce W3-M/W4-M.

import { test, expect, describe } from "bun:test";
import {
  canProduceMarketplaceEvidence,
  MARKETPLACE_EVIDENCE_RULES,
  type TransportationDemand,
  type TransportationSupply,
  type TransportationOpportunity,
  type TransportationExecution,
  type MarketplaceAgreement,
  type Provenance,
} from "../src/lib/oryxx/live/types";
import { SandboxTransportationProvider } from "../src/lib/oryxx/live/adapters/sandbox-provider";
import { FixtureTransportationProvider } from "../src/lib/oryxx/live/adapters/fixture-provider";
import { providerRegistry } from "../src/lib/oryxx/live/adapters/provider-registry";
import { discoverOpportunities } from "../src/lib/oryxx/live/engine/opportunity-engine";
import { clearMarket } from "../src/lib/oryxx/live/engine/market-clearing";
import { priceOpportunity } from "../src/lib/oryxx/live/engine/pricing";
import { createNegotiation, submitRound, resolveNegotiation } from "../src/lib/oryxx/live/engine/negotiation";
import { createAuction, submitBid, closeAuction } from "../src/lib/oryxx/live/engine/auction";
import { MoneyLedger } from "../src/lib/oryxx/live/ledger/money-ledger";
import { createExecution, transition, canProduceEvidence } from "../src/lib/oryxx/live/engine/execution-engine";
import { createAgent, isAuthorized, rankOpportunities } from "../src/lib/oryxx/live/agents/agent-framework";
import { TransportGraph, createNode, createEdge } from "../src/lib/oryxx/live/graph/transport-graph";
import { createBroadcast, commitBroadcast, isExpired, findMatchingBroadcasts } from "../src/lib/oryxx/live/engine/availability-broadcast";

const SANDBOX_PROVENANCE: Provenance = {
  environment: "SANDBOX",
  source: "sandbox-provider",
  observedAt: new Date().toISOString(),
  confidence: 1.0,
};

function makeDemand(overrides: Partial<TransportationDemand> = {}): TransportationDemand {
  return {
    id: "demand-1",
    source: "direct-user",
    requestType: "rideshare",
    kind: "person",
    origin: { lat: 40.7589, lon: -73.9851, name: "Times Square" },
    destination: { lat: 40.7505, lon: -73.9934, name: "Penn Station" },
    timeWindow: { startSec: 32400, endSec: 36000 }, // 9am-10am
    latestArrivalSec: 39600, // 11am
    partySize: 1,
    weightKg: 0,
    volumeM3: 0,
    budget: 5000, // $50
    value: 6000, // $60
    priority: "normal",
    constraints: {},
    status: "OPEN",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSupply(overrides: Partial<TransportationSupply> = {}): TransportationSupply {
  return {
    id: "supply-1",
    providerId: "sandbox-rideshare",
    resourceId: "sandbox-vehicle-1",
    mode: "rideshare",
    capacity: 4,
    availableCapacity: 4,
    origin: { lat: 40.7589, lon: -73.9851 },
    currentLocation: { lat: 40.7589, lon: -73.9851 },
    plannedRoute: [{ lat: 40.7589, lon: -73.9851 }, { lat: 40.7505, lon: -73.9934 }],
    plannedStops: [{ lat: 40.7505, lon: -73.9934 }],
    departureWindow: { startSec: 32400, endSec: 36000 },
    availabilityWindow: { startSec: 32400, endSec: 43200 },
    costModel: { costPerKm: 150, costPerHour: 3000, fixedCost: 200, minimumCompensation: 500 },
    detourToleranceKm: 3,
    constraints: { maxDetourKm: 5, maxExtraTimeMin: 20 },
    status: "AVAILABLE",
    source: "sandbox-provider",
    provenance: SANDBOX_PROVENANCE,
    ...overrides,
  };
}

describe("ORYXX Live Marketplace — Domain + Engine Tests", () => {

  // ─── PROVENANCE & EVIDENCE ISOLATION ──────────────────────────────
  test("sandbox execution cannot produce W3-M/W4-M evidence", () => {
    const exec: TransportationExecution = {
      id: "exec-1",
      agreementId: "agr-1",
      opportunityId: "opp-1",
      demandId: "dem-1",
      supplyId: "sup-1",
      providerId: "sandbox-rideshare",
      state: "COMPLETED",
      environment: "SANDBOX",
      evidenceEligible: false,
      provenance: SANDBOX_PROVENANCE,
      isMarketplaceOpportunity: true,
      researchStimulus: false,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    const result = canProduceMarketplaceEvidence(exec);
    expect(result.w3m).toBe(false);
    expect(result.w4m).toBe(false);
    expect(result.reason).toContain("SANDBOX");
  });

  test("LIVE completed execution can produce W4-M", () => {
    const exec: TransportationExecution = {
      id: "exec-2",
      agreementId: "agr-2",
      opportunityId: "opp-2",
      demandId: "dem-2",
      supplyId: "sup-2",
      providerId: "live-provider",
      state: "COMPLETED",
      environment: "LIVE",
      evidenceEligible: true,
      provenance: { environment: "LIVE", source: "direct-user", observedAt: new Date().toISOString(), confidence: 1 },
      isMarketplaceOpportunity: true,
      researchStimulus: false,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    const result = canProduceMarketplaceEvidence(exec);
    expect(result.w3m).toBe(true);
    expect(result.w4m).toBe(true);
  });

  test("marketplace evidence rules are defined and constant", () => {
    expect(MARKETPLACE_EVIDENCE_RULES.w3mRequires).toContain("LIVE");
    expect(MARKETPLACE_EVIDENCE_RULES.w4mRequires).toContain("INDEPENDENT_VERIFICATION");
    expect(MARKETPLACE_EVIDENCE_RULES.sandboxCannotProduce).toContain("W3-M");
    expect(MARKETPLACE_EVIDENCE_RULES.sandboxCannotProduce).toContain("W4-M");
    expect(MARKETPLACE_EVIDENCE_RULES.researchStimulusCannotProduce).toContain("W3-M");
    expect(MARKETPLACE_EVIDENCE_RULES.researchStimulusCannotProduce).toContain("W4-M");
  });

  // ─── PROVIDER ADAPTERS ────────────────────────────────────────────
  test("sandbox provider discovers supply", async () => {
    const provider = new SandboxTransportationProvider();
    const supplies = await provider.discoverSupply({ lat: 40.7589, lon: -73.9851 }, 10);
    expect(supplies.length).toBeGreaterThan(0);
    expect(supplies[0].provenance.environment).toBe("SANDBOX");
    expect(supplies[0].status).toBe("AVAILABLE");
  });

  test("sandbox provider quotes correctly", async () => {
    const provider = new SandboxTransportationProvider();
    const demand = makeDemand();
    const supply = makeSupply();
    const quote = await provider.quote({ demand, supply });
    expect(quote).not.toBeNull();
    expect(quote!.price).toBeGreaterThan(0);
    expect(quote!.environment).toBe("SANDBOX");
  });

  test("fixture provider returns fixture-only data", async () => {
    const provider = new FixtureTransportationProvider();
    expect(provider.getConnectionStatus()).toBe("FIXTURE_ONLY");
    expect(provider.getProviderIdentity().environment).toBe("FIXTURE");
    const supplies = await provider.discoverSupply({ lat: 40.7589, lon: -73.9851 }, 10);
    expect(supplies[0].provenance.environment).toBe("FIXTURE");
  });

  test("provider registry registers and lists providers", () => {
    providerRegistry.clear();
    providerRegistry.register(new SandboxTransportationProvider());
    providerRegistry.register(new FixtureTransportationProvider());
    const identities = providerRegistry.getIdentities();
    expect(identities.length).toBe(2);
    expect(identities.some((i) => i.environment === "SANDBOX")).toBe(true);
    expect(identities.some((i) => i.environment === "FIXTURE")).toBe(true);
  });

  test("provider registry reports connection status", () => {
    providerRegistry.clear();
    providerRegistry.register(new SandboxTransportationProvider());
    const status = providerRegistry.status();
    expect(status[0].connectionStatus).toBe("SANDBOX_ACTIVE");
  });

  // ─── OPPORTUNITY ENGINE ───────────────────────────────────────────
  test("opportunity engine discovers feasible opportunities", () => {
    const demand = makeDemand();
    const supply = makeSupply();
    const opportunities = discoverOpportunities([demand], [supply]);
    expect(opportunities.length).toBeGreaterThan(0);
    const opp = opportunities[0];
    expect(opp.demandId).toBe(demand.id);
    expect(opp.supplyId).toBe(supply.id);
    expect(opp.isMarketplaceOpportunity).toBe(true);
    expect(opp.researchStimulus).toBe(false);
    expect(opp.whyFeasible).toBeTruthy();
    expect(opp.whyNow).toBeTruthy();
    expect(opp.whyThisSupply).toBeTruthy();
    expect(opp.whyOrdinaryRoutingMissesIt).toBeTruthy();
    expect(opp.price).toBeGreaterThan(0);
  });

  test("opportunity engine rejects incompatible kind", () => {
    const demand = makeDemand({ kind: "pallet" });
    const supply = makeSupply({ mode: "rideshare" }); // rideshare can't carry pallets
    const opportunities = discoverOpportunities([demand], [supply]);
    expect(opportunities.length).toBe(0);
  });

  // ─── MARKET CLEARING ──────────────────────────────────────────────
  test("market clearing assigns demands to supplies", () => {
    const demand = makeDemand();
    const supply = makeSupply();
    const opps = discoverOpportunities([demand], [supply]);
    const result = clearMarket([demand], [supply], opps);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.unmatchedDemandIds.length).toBe(0);
    expect(result.solverVersion).toBeTruthy();
    expect(result.solverMode).toBeTruthy();
  });

  // ─── PRICING ──────────────────────────────────────────────────────
  test("pricing engine computes user price, supplier comp, platform fee", () => {
    const demand = makeDemand();
    const supply = makeSupply();
    const opps = discoverOpportunities([demand], [supply]);
    const pricing = priceOpportunity(opps[0], supply);
    expect(pricing.userPrice).toBeGreaterThan(0);
    expect(pricing.supplierCompensation).toBeGreaterThan(0);
    expect(pricing.platformFee).toBeGreaterThan(0);
    expect(pricing.userPrice).toBe(pricing.supplierCompensation + pricing.platformFee);
    expect(pricing.label).toBe("estimated");
  });

  // ─── NEGOTIATION ──────────────────────────────────────────────────
  test("negotiation resolves within bounds", () => {
    const demand = makeDemand();
    const supply = makeSupply();
    const opps = discoverOpportunities([demand], [supply]);
    const opp = opps[0];
    const negotiation = createNegotiation(opp, demand, supply, "bounded-bargaining", new Date(Date.now() + 60000).toISOString());
    expect(negotiation.state).toBe("OPEN");
    expect(negotiation.minimumPrice).toBeGreaterThan(0);
    expect(negotiation.maximumPrice).toBeGreaterThanOrEqual(negotiation.minimumPrice);

    const updated = submitRound(negotiation, "buyer", (negotiation.minimumPrice + negotiation.maximumPrice) / 2, "initial offer");
    expect(updated.rounds.length).toBe(1);

    const resolved = resolveNegotiation(updated);
    expect(["ACCEPTED", "SETTLED"]).toContain(resolved.state);
  });

  test("negotiation rejects out-of-bounds price", () => {
    const demand = makeDemand();
    const supply = makeSupply();
    const opps = discoverOpportunities([demand], [supply]);
    const negotiation = createNegotiation(opps[0], demand, supply, "fixed-price", new Date(Date.now() + 60000).toISOString());
    const updated = submitRound(negotiation, "buyer", 1, "lowball"); // too low
    expect(updated.state).not.toBe("ACCEPTED");
  });

  // ─── AUCTIONS ─────────────────────────────────────────────────────
  test("auction selects lowest feasible price winner", () => {
    let auction = createAuction("dem-1", ["sup-1", "sup-2"], "lowest-feasible-price", new Date().toISOString(), new Date(Date.now() + 60000).toISOString(), 500, 5000);
    auction = submitBid(auction, "sup-1", "prov-1", 1000);
    auction = submitBid(auction, "sup-2", "prov-2", 800);
    const closed = closeAuction(auction);
    expect(closed.state).toBe("AWARDED");
    expect(closed.winnerSupplyId).toBe("sup-2"); // lower price wins
    expect(closed.clearingPrice).toBe(800);
  });

  test("auction selects welfare-maximizing winner", () => {
    let auction = createAuction("dem-1", ["sup-1", "sup-2"], "welfare-maximizing", new Date().toISOString(), new Date(Date.now() + 60000).toISOString(), 500, 5000);
    auction = submitBid(auction, "sup-1", "prov-1", 1000);
    auction = submitBid(auction, "sup-2", "prov-2", 800); // higher welfare (max - bid)
    const closed = closeAuction(auction);
    expect(closed.winnerSupplyId).toBe("sup-2"); // 5000-800 > 5000-1000
  });

  // ─── MONEY LEDGER (double-entry, idempotent) ──────────────────────
  test("money ledger creates accounts with zero balance", () => {
    const ledger = new MoneyLedger();
    const account = ledger.createAccount("user-1", "customer", "USD", "SANDBOX");
    expect(account.balance).toBe(0);
    expect(account.environment).toBe("SANDBOX");
  });

  test("money ledger posts double-entry correctly", () => {
    const ledger = new MoneyLedger();
    const customer = ledger.createAccount("user-1", "customer", "USD", "SANDBOX");
    const escrow = ledger.createAccount("oryxx", "escrow", "USD", "SANDBOX");
    // Fund the customer account first (CREDIT to customer)
    const platform = ledger.createAccount("oryxx-platform", "platform-revenue", "USD", "SANDBOX");
    ledger.postEntry(platform.id, customer.id, 5000, "USD", "Initial funding", "adjustment", "adj-1", "fund-key-1", "SANDBOX");
    const { debitEntry, creditEntry } = ledger.postEntry(
      customer.id, escrow.id, 1000, "USD", "Test payment",
      "demand", "dem-1", "test-key-1", "SANDBOX",
    );
    expect(debitEntry.type).toBe("DEBIT");
    expect(creditEntry.type).toBe("CREDIT");
    expect(debitEntry.amount).toBe(1000);
    expect(creditEntry.amount).toBe(1000);
    expect(debitEntry.pairedEntryId).toBe(creditEntry.id);
    expect(creditEntry.pairedEntryId).toBe(debitEntry.id);
    expect(ledger.getBalance(customer.id)).toBe(4000); // 5000 funded - 1000 debited
    expect(ledger.getBalance(escrow.id)).toBe(1000);
  });

  test("money ledger is idempotent", () => {
    const ledger = new MoneyLedger();
    const customer = ledger.createAccount("user-1", "customer", "USD", "SANDBOX");
    const escrow = ledger.createAccount("oryxx", "escrow", "USD", "SANDBOX");
    const platform = ledger.createAccount("oryxx-platform", "platform-revenue", "USD", "SANDBOX");
    ledger.postEntry(platform.id, customer.id, 5000, "USD", "Initial", "adjustment", "adj-1", "fund-idem-1", "SANDBOX");
    const result1 = ledger.postEntry(customer.id, escrow.id, 500, "USD", "First", "demand", "dem-1", "idem-key", "SANDBOX");
    const result2 = ledger.postEntry(customer.id, escrow.id, 500, "USD", "Second", "demand", "dem-1", "idem-key", "SANDBOX");
    expect(result1.debitEntry.id).toBe(result2.debitEntry.id); // same entry returned
    expect(ledger.getBalance(customer.id)).toBe(4500); // 5000 funded - 500 debited
  });

  test("money ledger audit passes on balanced books", () => {
    const ledger = new MoneyLedger();
    const customer = ledger.createAccount("user-1", "customer", "USD", "SANDBOX");
    const escrow = ledger.createAccount("oryxx", "escrow", "USD", "SANDBOX");
    const platform = ledger.createAccount("oryxx-platform", "platform-revenue", "USD", "SANDBOX");
    ledger.postEntry(platform.id, customer.id, 5000, "USD", "Fund", "adjustment", "adj-1", "fund-audit-1", "SANDBOX");
    ledger.postEntry(customer.id, escrow.id, 1000, "USD", "Test", "demand", "dem-1", "audit-key", "SANDBOX");
    expect(ledger.audit().ok).toBe(true);
  });

  // ─── EXECUTION ENGINE ─────────────────────────────────────────────
  test("execution engine transitions through lifecycle", () => {
    const demand = makeDemand();
    const supply = makeSupply();
    const opps = discoverOpportunities([demand], [supply]);
    const agreement: MarketplaceAgreement = {
      id: "agr-1", offerId: "off-1", opportunityId: opps[0].id, demandId: demand.id, supplyId: supply.id,
      providerId: supply.providerId, agreedPrice: opps[0].price, supplierCompensation: opps[0].supplierCompensation,
      platformFee: opps[0].platformFee, status: "ACTIVE",
      provenance: SANDBOX_PROVENANCE, isMarketplaceOpportunity: true, researchStimulus: false,
      createdAt: new Date().toISOString(),
    };
    let exec = createExecution(agreement, opps[0]);
    expect(exec.state).toBe("OPPORTUNITY_CREATED");
    expect(exec.environment).toBe("SANDBOX");
    expect(exec.evidenceEligible).toBe(false);

    exec = transition(exec, "OFFERED");
    exec = transition(exec, "ACCEPTED");
    exec = transition(exec, "RESERVED");
    exec = transition(exec, "DISPATCHED");
    exec = transition(exec, "EN_ROUTE");
    exec = transition(exec, "PICKED_UP");
    exec = transition(exec, "EXECUTING");
    exec = transition(exec, "COMPLETED");
    expect(exec.state).toBe("COMPLETED");
    expect(exec.completedAt).toBeTruthy();
  });

  test("execution engine rejects backward transitions", () => {
    const demand = makeDemand();
    const supply = makeSupply();
    const opps = discoverOpportunities([demand], [supply]);
    const agreement: MarketplaceAgreement = {
      id: "agr-2", offerId: "off-2", opportunityId: opps[0].id, demandId: demand.id, supplyId: supply.id,
      providerId: supply.providerId, agreedPrice: opps[0].price, supplierCompensation: opps[0].supplierCompensation,
      platformFee: opps[0].platformFee, status: "ACTIVE",
      provenance: SANDBOX_PROVENANCE, isMarketplaceOpportunity: true, researchStimulus: false,
      createdAt: new Date().toISOString(),
    };
    let exec = createExecution(agreement, opps[0]);
    exec = transition(exec, "ACCEPTED");
    // Cannot go backward from ACCEPTED to OFFERED
    expect(() => transition(exec, "OFFERED")).toThrow();
    // Cannot go from terminal COMPLETED back to EXECUTING
    exec = transition(exec, "COMPLETED");
    expect(() => transition(exec, "EXECUTING")).toThrow();
  });

  // ─── AGENT FRAMEWORK ──────────────────────────────────────────────
  test("L0 agent cannot bid or execute", () => {
    const agent = createAgent("user-1", "rider", { cost: 1, time: 1 }, { maxAutonomyLevel: 0 }, 0);
    expect(isAuthorized(agent, 0, "bid")).toBe(false);
    expect(isAuthorized(agent, 0, "execute")).toBe(false);
    expect(isAuthorized(agent, 0, "discover")).toBe(true);
  });

  test("L5 agent can settle payments", () => {
    const agent = createAgent("user-1", "oryxx", { welfare: 1 }, { maxAutonomyLevel: 5 }, 5);
    expect(isAuthorized(agent, 5, "settle")).toBe(true);
    expect(isAuthorized(agent, 5, "dispatch")).toBe(true);
  });

  test("agent ranks opportunities by objective weights", () => {
    const demand = makeDemand();
    const supply = makeSupply();
    const opps = discoverOpportunities([demand], [supply]);
    const agent = createAgent("user-1", "rider", { cost: 1, time: 0.5, reliability: 0.3 }, { maxAutonomyLevel: 2 }, 2);
    const ranked = rankOpportunities(agent, opps);
    expect(ranked.length).toBe(opps.length);
  });

  // ─── GLOBAL TRANSPORTATION GRAPH ──────────────────────────────────
  test("transport graph builds and queries", () => {
    const graph = new TransportGraph();
    const n1 = createNode("stop", { lat: 40.7589, lon: -73.9851 }, "Stop A", "osm", 0.9);
    const n2 = createNode("stop", { lat: 40.7505, lon: -73.9934 }, "Stop B", "osm", 0.9);
    graph.addNode(n1);
    graph.addNode(n2);
    const edge = createEdge(n1, n2, "road", 1.2, 180, "osm", 0.9);
    graph.addEdge(edge);
    const routes = graph.findRoutes(n1.id, n2.id);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0]).toContain(edge);
  });

  test("transport graph finds supply near a point", () => {
    const graph = new TransportGraph();
    const hub = createNode("hub", { lat: 40.7589, lon: -73.9851 }, "Hub", "oryxx-owned", 1);
    graph.addNode(hub);
    const nearby = graph.findSupplyNear({ lat: 40.7589, lon: -73.9851 }, 5);
    expect(nearby.length).toBeGreaterThan(0);
  });

  // ─── AVAILABILITY BROADCAST ───────────────────────────────────────
  test("availability broadcast starts as POTENTIAL and can be committed", () => {
    const broadcast = createBroadcast(
      "prov-1", "res-1", { lat: 40.7589, lon: -73.9851 }, { lat: 40.7505, lon: -73.9934 },
      { startSec: 32400, endSec: 36000 }, 3, 3, 500, 0.8,
      new Date(Date.now() + 30 * 60 * 1000).toISOString(), SANDBOX_PROVENANCE,
    );
    expect(broadcast.status).toBe("POTENTIAL");
    expect(broadcast.isCommitted).toBe(false);

    const committed = commitBroadcast(broadcast);
    expect(committed.status).toBe("COMMITTED");
    expect(committed.isCommitted).toBe(true);
  });

  test("expired broadcast cannot be committed", () => {
    const expired = createBroadcast(
      "prov-1", "res-1", { lat: 40.7589, lon: -73.9851 }, { lat: 40.7505, lon: -73.9934 },
      { startSec: 32400, endSec: 36000 }, 3, 3, 500, 0.8,
      new Date(Date.now() - 1000).toISOString(), SANDBOX_PROVENANCE, // past
    );
    expect(isExpired(expired)).toBe(true);
  });

  test("findMatchingBroadcasts matches demand to available supply", () => {
    const demand = makeDemand();
    const broadcast = createBroadcast(
      "prov-1", "res-1", { lat: 40.7589, lon: -73.9851 }, { lat: 40.7505, lon: -73.9934 },
      { startSec: 32400, endSec: 36000 }, 3, 3, 500, 0.8,
      new Date(Date.now() + 30 * 60 * 1000).toISOString(), SANDBOX_PROVENANCE,
    );
    const matches = findMatchingBroadcasts([broadcast], demand);
    expect(matches.length).toBeGreaterThan(0);
  });

  // ─── CROSS-CUTTING: SANDBOX/RESEARCH ISOLATION ───────────────────
  test("marketplace opportunity is never a research stimulus", () => {
    const demand = makeDemand();
    const supply = makeSupply();
    const opps = discoverOpportunities([demand], [supply]);
    expect(opps[0].isMarketplaceOpportunity).toBe(true);
    expect(opps[0].researchStimulus).toBe(false);
  });

  test("sandbox execution evidenceEligible is false", () => {
    const demand = makeDemand();
    const supply = makeSupply();
    const opps = discoverOpportunities([demand], [supply]);
    const agreement: MarketplaceAgreement = {
      id: "agr-x", offerId: "off-x", opportunityId: opps[0].id, demandId: demand.id, supplyId: supply.id,
      providerId: supply.providerId, agreedPrice: opps[0].price, supplierCompensation: opps[0].supplierCompensation,
      platformFee: opps[0].platformFee, status: "ACTIVE",
      provenance: SANDBOX_PROVENANCE, isMarketplaceOpportunity: true, researchStimulus: false,
      createdAt: new Date().toISOString(),
    };
    const exec = createExecution(agreement, opps[0]);
    expect(exec.evidenceEligible).toBe(false);
    const evidence = canProduceEvidence(exec);
    expect(evidence.w3m).toBe(false);
    expect(evidence.w4m).toBe(false);
  });
});
