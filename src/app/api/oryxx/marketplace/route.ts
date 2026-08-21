// ORYXX — Live Marketplace API
//
// Provider-neutral marketplace operations: demand creation, supply discovery,
// opportunity evaluation, market clearing, negotiation, payment, execution.
// All operations carry explicit environment provenance (FIXTURE/SANDBOX/LIVE).
// Sandbox operations NEVER produce W3-M/W4-M evidence.

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { db } from "@/lib/db";
import { providerRegistry } from "@/lib/oryxx/live/adapters/provider-registry";
import { SandboxTransportationProvider } from "@/lib/oryxx/live/adapters/sandbox-provider";
import { FixtureTransportationProvider } from "@/lib/oryxx/live/adapters/fixture-provider";
import { discoverOpportunities } from "@/lib/oryxx/live/engine/opportunity-engine";
import { clearMarket } from "@/lib/oryxx/live/engine/market-clearing";
import { priceOpportunity } from "@/lib/oryxx/live/engine/pricing";
import { MoneyLedger } from "@/lib/oryxx/live/ledger/money-ledger";
import {
  createExecution,
  transition,
} from "@/lib/oryxx/live/engine/execution-engine";
import type { TransportationDemand, TransportationSupply, Environment } from "@/lib/oryxx/live/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Register providers (idempotent)
let providersRegistered = false;
function ensureProviders() {
  if (providersRegistered) return;
  providerRegistry.register(new SandboxTransportationProvider());
  providerRegistry.register(new FixtureTransportationProvider());
  providersRegistered = true;
}

// Singleton ledger (in-memory; production would use DB-backed)
let ledgerInstance: MoneyLedger | null = null;
function getLedger(): MoneyLedger {
  if (!ledgerInstance) ledgerInstance = new MoneyLedger();
  return ledgerInstance;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  ensureProviders();
  const url = new URL(req.url);
  const view = url.searchParams.get("view") || "overview";

  if (view === "providers") {
    return NextResponse.json({ providers: providerRegistry.status() });
  }

  if (view === "demands") {
    const demands = await db.transportationDemand.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return NextResponse.json({ demands });
  }

  if (view === "opportunities") {
    const opportunities = await db.transportationOpportunity.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { demand: true, supply: true },
    });
    return NextResponse.json({ opportunities });
  }

  if (view === "executions") {
    const executions = await db.transportationExecution.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { opportunity: true },
    });
    return NextResponse.json({ executions });
  }

  if (view === "ledger") {
    const ledger = getLedger();
    const accounts = ledger["accounts"] as Map<string, any>;
    const entries = ledger["entries"] as any[];
    return NextResponse.json({
      accounts: accounts ? [...accounts.values()] : [],
      entryCount: entries?.length || 0,
      auditPassed: ledger.audit(),
    });
  }

  if (view === "broadcasts") {
    const broadcasts = await db.availabilityBroadcast.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return NextResponse.json({ broadcasts });
  }

  // Default overview
  const [demandCount, supplyCount, opportunityCount, executionCount, broadcastCount] = await Promise.all([
    db.transportationDemand.count(),
    db.transportationSupply.count(),
    db.transportationOpportunity.count(),
    db.transportationExecution.count(),
    db.availabilityBroadcast.count(),
  ]);

  return NextResponse.json({
    overview: {
      demands: demandCount,
      supplies: supplyCount,
      opportunities: opportunityCount,
      executions: executionCount,
      broadcasts: broadcastCount,
    },
    providers: providerRegistry.status(),
    environment: "SANDBOX" as Environment,
    note: "Sandbox marketplace — no live provider integrations. Sandbox execution cannot produce W3-M/W4-M evidence.",
  });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  ensureProviders();
  const email = (session.user as any)?.email;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  const mode = body?.mode;

  // === CREATE DEMAND ===
  if (mode === "create_demand") {
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
        windowStartSec: body.windowStartSec ?? Math.floor(Date.now() / 1000) % 86400,
        windowEndSec: body.windowEndSec ?? (Math.floor(Date.now() / 1000) % 86400) + 3600,
        latestArrivalSec: body.latestArrivalSec ?? (Math.floor(Date.now() / 1000) % 86400) + 7200,
        partySize: body.partySize ?? 1,
        weightKg: body.weightKg ?? 0,
        volumeM3: body.volumeM3 ?? 0,
        budget: body.budget ?? 5000, // $50.00 in minor units
        value: body.value ?? 6000, // $60.00
        priority: body.priority || "normal",
        constraintsJson: body.constraints ? JSON.stringify(body.constraints) : null,
        userId: email,
        environment: "SANDBOX",
      },
    });
    await db.marketplaceEvent.create({
      data: { eventType: "demand-created", referenceType: "demand", referenceId: demand.id, environment: "SANDBOX", payloadJson: JSON.stringify({ demandId: demand.id }) },
    });
    return NextResponse.json({ demand, message: "Demand created in SANDBOX environment." });
  }

  // === DISCOVER SUPPLY ===
  if (mode === "discover_supply") {
    const demand = await db.transportationDemand.findUnique({ where: { id: body.demandId } });
    if (!demand) return NextResponse.json({ error: "Demand not found." }, { status: 404 });

    // Discover from all connected providers
    const supplies = await providerRegistry.discoverAllSupply(
      { lat: demand.originLat, lon: demand.originLon },
      10, // 10km radius
    );

    // Persist discovered supplies
    const created = [];
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
          currentLat: supply.currentLocation?.lat,
          currentLon: supply.currentLocation?.lon,
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
          status: supply.status,
          source: supply.source,
          environment: supply.provenance.environment,
          provenanceJson: JSON.stringify(supply.provenance),
        },
      });
      created.push(dbSupply);
    }
    return NextResponse.json({ supplies: created, count: created.length });
  }

  // === DISCOVER OPPORTUNITIES ===
  if (mode === "discover_opportunities") {
    const demand = await db.transportationDemand.findUnique({ where: { id: body.demandId } });
    if (!demand) return NextResponse.json({ error: "Demand not found." }, { status: 404 });

    const dbSupplies = await db.transportationSupply.findMany({
      where: { status: "AVAILABLE", environment: demand.environment },
      take: 100,
    });

    // Convert DB rows to domain types
    const domainDemand: TransportationDemand = {
      id: demand.id,
      source: demand.source as any,
      requestType: demand.requestType as any,
      kind: demand.kind as any,
      origin: { lat: demand.originLat, lon: demand.originLon, name: demand.originName || undefined },
      destination: { lat: demand.destLat, lon: demand.destLon, name: demand.destName || undefined },
      timeWindow: { startSec: demand.windowStartSec, endSec: demand.windowEndSec },
      latestArrivalSec: demand.latestArrivalSec,
      partySize: demand.partySize,
      weightKg: demand.weightKg,
      volumeM3: demand.volumeM3,
      budget: demand.budget,
      value: demand.value,
      priority: demand.priority as any,
      constraints: demand.constraintsJson ? JSON.parse(demand.constraintsJson) : {},
      status: demand.status as any,
      createdAt: demand.createdAt.toISOString(),
      userId: demand.userId || undefined,
    };

    const domainSupplies: TransportationSupply[] = dbSupplies.map((s) => ({
      id: s.id,
      providerId: s.providerId,
      resourceId: s.resourceId,
      mode: s.mode as any,
      capacity: s.capacity,
      availableCapacity: s.availableCapacity,
      origin: { lat: s.originLat, lon: s.originLon },
      currentLocation: s.currentLat != null ? { lat: s.currentLat, lon: s.currentLon! } : undefined,
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
      status: s.status as any,
      source: s.source as any,
      provenance: s.provenanceJson ? JSON.parse(s.provenanceJson) : { environment: s.environment as Environment, source: s.source as any, observedAt: s.createdAt.toISOString(), confidence: 1 },
    }));

    const opportunities = discoverOpportunities([domainDemand], domainSupplies);

    // Persist opportunities
    const created = [];
    for (const opp of opportunities) {
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
          whyFeasible: opp.whyFeasible,
          whyNow: opp.whyNow,
          whyThisSupply: opp.whyThisSupply,
          whyOrdinaryMisses: opp.whyOrdinaryRoutingMissesIt,
          isMarketplaceOpportunity: true,
          researchStimulus: false,
          environment: "SANDBOX",
          provenanceJson: JSON.stringify(opp.provenance),
        },
      });
      created.push(dbOpp);
      await db.marketplaceEvent.create({
        data: { eventType: "opportunity-discovered", referenceType: "opportunity", referenceId: dbOpp.id, environment: "SANDBOX" },
      });
    }
    return NextResponse.json({ opportunities: created, count: created.length });
  }

  // === CLEAR MARKET ===
  if (mode === "clear_market") {
    const demand = await db.transportationDemand.findUnique({ where: { id: body.demandId } });
    if (!demand) return NextResponse.json({ error: "Demand not found." }, { status: 404 });

    const opportunities = await db.transportationOpportunity.findMany({
      where: { demandId: body.demandId, status: "DISCOVERED" },
    });

    // Simple clearing: accept the best opportunity (highest welfare)
    if (opportunities.length === 0) {
      return NextResponse.json({ error: "No opportunities to clear." }, { status: 400 });
    }

    const best = opportunities[0]; // already sorted by welfare desc from discovery
    await db.transportationOpportunity.update({
      where: { id: best.id },
      data: { status: "ACCEPTED" },
    });

    // Create offer
    const offer = await db.marketplaceOffer.create({
      data: {
        opportunityId: best.id,
        demandId: best.demandId,
        supplyId: best.supplyId,
        providerId: best.providerId,
        userPrice: best.price,
        supplierCompensation: best.supplierCompensation,
        platformFee: best.platformFee,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        status: "ACCEPTED",
        isMarketplaceOpportunity: true,
        researchStimulus: false,
        environment: "SANDBOX",
      },
    });

    // Create agreement
    const agreement = await db.marketplaceAgreement.create({
      data: {
        offerId: offer.id,
        opportunityId: best.id,
        demandId: best.demandId,
        supplyId: best.supplyId,
        providerId: best.providerId,
        agreedPrice: best.price,
        supplierCompensation: best.supplierCompensation,
        platformFee: best.platformFee,
        status: "ACTIVE",
        isMarketplaceOpportunity: true,
        researchStimulus: false,
        environment: "SANDBOX",
      },
    });

    // Create execution (sandbox — evidenceEligible=false)
    const execution = await db.transportationExecution.create({
      data: {
        agreementId: agreement.id,
        opportunityId: best.id,
        demandId: best.demandId,
        supplyId: best.supplyId,
        providerId: best.providerId,
        state: "ACCEPTED",
        environment: "SANDBOX",
        evidenceEligible: false, // SANDBOX cannot produce W3-M/W4-M
        isMarketplaceOpportunity: true,
        researchStimulus: false,
      },
    });

    await db.marketplaceEvent.create({
      data: { eventType: "agreement-signed", referenceType: "agreement", referenceId: agreement.id, environment: "SANDBOX" },
    });

    return NextResponse.json({
      opportunity: best,
      offer,
      agreement,
      execution,
      message: "Market cleared (SANDBOX). Execution created but evidenceEligible=false — cannot produce W3-M/W4-M.",
    });
  }

  // === AUTHORIZE PAYMENT ===
  if (mode === "authorize_payment") {
    const agreement = await db.marketplaceAgreement.findUnique({ where: { id: body.agreementId } });
    if (!agreement) return NextResponse.json({ error: "Agreement not found." }, { status: 404 });

    const ledger = getLedger();
    // Ensure customer + escrow accounts exist
    let customerAccount = await db.moneyAccount.findFirst({ where: { ownerId: agreement.demandId, type: "customer" } });
    if (!customerAccount) {
      customerAccount = await db.moneyAccount.create({
        data: { ownerId: agreement.demandId, type: "customer", currency: "USD", balance: 100000, environment: "SANDBOX" }, // $1000 sandbox balance
      });
    }
    let escrowAccount = await db.moneyAccount.findFirst({ where: { ownerId: "oryxx-escrow", type: "escrow" } });
    if (!escrowAccount) {
      escrowAccount = await db.moneyAccount.create({
        data: { ownerId: "oryxx-escrow", type: "escrow", currency: "USD", balance: 0, environment: "SANDBOX" },
      });
    }

    // Create payment intent
    const intent = await db.paymentIntent.create({
      data: {
        demandId: agreement.demandId,
        agreementId: agreement.id,
        customerId: customerAccount.id,
        supplierId: agreement.providerId,
        amount: agreement.agreedPrice,
        userPrice: agreement.agreedPrice,
        supplierCompensation: agreement.supplierCompensation,
        platformFee: agreement.platformFee,
        currency: "USD",
        status: "AUTHORIZED",
        idempotencyKey: `pay-${agreement.id}-${Date.now()}`,
        environment: "SANDBOX",
      },
    });

    // Post ledger entries (double-entry)
    await db.ledgerEntry.create({
      data: {
        accountId: customerAccount.id, type: "DEBIT", amount: agreement.agreedPrice, description: `Payment for demand ${agreement.demandId}`,
        referenceType: "payment-intent", referenceId: intent.id, idempotencyKey: `debit-${intent.idempotencyKey}`, pairedEntryId: "", environment: "SANDBOX",
      },
    });
    await db.ledgerEntry.create({
      data: {
        accountId: escrowAccount.id, type: "CREDIT", amount: agreement.agreedPrice, description: `Escrow for demand ${agreement.demandId}`,
        referenceType: "payment-intent", referenceId: intent.id, idempotencyKey: `credit-${intent.idempotencyKey}`, pairedEntryId: "", environment: "SANDBOX",
      },
    });

    await db.marketplaceEvent.create({
      data: { eventType: "payment-authorized", referenceType: "payment-intent", referenceId: intent.id, environment: "SANDBOX" },
    });

    return NextResponse.json({ paymentIntent: intent, message: "Payment authorized (SANDBOX). No real money." });
  }

  // === COMPLETE EXECUTION ===
  if (mode === "complete_execution") {
    const execution = await db.transportationExecution.findUnique({ where: { id: body.executionId } });
    if (!execution) return NextResponse.json({ error: "Execution not found." }, { status: 404 });

    if (execution.environment !== "SANDBOX") {
      return NextResponse.json({ error: "Only SANDBOX execution can be completed via this endpoint." }, { status: 403 });
    }

    // Transition through sandbox execution lifecycle
    let updated = await db.transportationExecution.update({
      where: { id: execution.id },
      data: { state: "DISPATCHED", startedAt: new Date() },
    });
    updated = await db.transportationExecution.update({
      where: { id: execution.id },
      data: { state: "EN_ROUTE" },
    });
    updated = await db.transportationExecution.update({
      where: { id: execution.id },
      data: { state: "PICKED_UP" },
    });
    updated = await db.transportationExecution.update({
      where: { id: execution.id },
      data: { state: "EXECUTING" },
    });
    updated = await db.transportationExecution.update({
      where: { id: execution.id },
      data: { state: "COMPLETED", completedAt: new Date() },
    });

    await db.marketplaceEvent.create({
      data: { eventType: "execution-completed", referenceType: "execution", referenceId: execution.id, environment: "SANDBOX" },
    });

    return NextResponse.json({
      execution: updated,
      evidenceProduced: { w3m: false, w4m: false, reason: "SANDBOX execution cannot produce W3-M/W4-M evidence (evidenceEligible=false)" },
      message: "Execution completed in SANDBOX. No marketplace evidence produced.",
    });
  }

  // === BROADCAST AVAILABILITY ===
  if (mode === "broadcast_availability") {
    const broadcast = await db.availabilityBroadcast.create({
      data: {
        providerId: body.providerId || "sandbox-rideshare",
        resourceId: body.resourceId || "sandbox-vehicle-1",
        currentLat: body.currentLat ?? 40.7589,
        currentLon: body.currentLon ?? -73.9851,
        destLat: body.destLat ?? 40.7505,
        destLon: body.destLon ?? -73.9934,
        departureStartSec: body.departureStartSec ?? Math.floor(Date.now() / 1000) % 86400,
        departureEndSec: body.departureEndSec ?? (Math.floor(Date.now() / 1000) % 86400) + 3600,
        availableCapacity: body.availableCapacity ?? 3,
        detourToleranceKm: body.detourToleranceKm ?? 3,
        minimumCompensation: body.minimumCompensation ?? 500,
        confidence: body.confidence ?? 0.8,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        status: "POTENTIAL",
        isCommitted: false,
        environment: "SANDBOX",
      },
    });
    return NextResponse.json({ broadcast, message: "Availability broadcast created (POTENTIAL — not committed supply)." });
  }

  return NextResponse.json({ error: "Unknown mode." }, { status: 400 });
}
