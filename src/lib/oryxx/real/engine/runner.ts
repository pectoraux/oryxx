// ORYXX — Real-world opportunity experiment runner.
//
// Runs the full experiment: load pilot data → generate demands → infer latent
// supply → compute baseline → discover opportunities → compute metrics →
// planning-horizon + density curves. Deterministic given config.

import type {
  RealExperimentConfig,
  OpportunityExperimentResult,
  DemandObservation,
  ObservedMovement,
  LatentSupply,
  TransportationOpportunity,
  DataSource,
  Assumption,
} from "../types";
import { FixtureAccraProvider, ACCRA_PILOT, ACCRA_FIXTURE_SOURCE } from "../providers/fixture-accra";
import type { TransportationDataProvider } from "../providers/interface";
import {
  generateDemands,
  generateOpportunities,
  inferLatentSupply,
  computeBaseline,
  planningHorizonCurve,
  densityCurve,
} from "./opportunity";
import { describe } from "../../market/experiment/statistics";

export function runOpportunityExperiment(config: RealExperimentConfig): OpportunityExperimentResult {
  const provider = new FixtureAccraProvider(config.seed, config.movementDensity);

  // load pilot data (fixture exposes sync accessors)
  const nodes = provider.getGeographicNodesSync();
  const transit = provider.getTransitFeedSync();
  const pilot = provider.getPilotGeographySync();
  const dataSources: DataSource[] = [ACCRA_FIXTURE_SOURCE];

  // generate demands
  const demands = generateDemands(config, nodes);

  // filter movements by planning horizon
  const horizonEnd = 24 * 3600 + config.planningHorizonSec;
  const movements = provider.getObservedMovementsSync(0, horizonEnd).filter((m) => {
    if (config.hourFilter != null) {
      const hour = Math.floor(m.departureSec / 3600);
      if (Math.abs(hour - config.hourFilter) > 1) return false;
    }
    return true;
  });

  // infer latent supply (Layer A → Layer B)
  const { supply: latent, assumptions } = inferLatentSupply(movements, config, ACCRA_FIXTURE_SOURCE);

  // baseline: ordinary multimodal routing
  const baselineResult = computeBaseline(demands, transit, nodes);

  // discover opportunities
  const opportunities = generateOpportunities(
    demands,
    latent,
    baselineResult.perDemand,
    nodes,
    config,
    dataSources,
  );

  // metrics
  const feasibleOpps = opportunities.filter((o) => o.tier >= 1);
  const economicOpps = opportunities.filter((o) => o.tier >= 2 && o.estimatedSocialSurplus > 0);
  const highConfOpps = opportunities.filter((o) => o.confidence.overall >= 0.6);
  const totalValue = opportunities.reduce((a, o) => a + o.estimatedSocialSurplus, 0);
  const values = opportunities.map((o) => o.estimatedSocialSurplus).sort((a, b) => a - b);
  const oppPer1000 = demands.length > 0 ? Math.round((opportunities.length / demands.length) * 1000) : 0;

  // split value: multimodal vs latent-supply discovery
  // multimodal value = opportunities where baseline already used transit (no latent dependency)
  // latent value = opportunities that REQUIRE latent-supply info
  const latentValue = opportunities
    .filter((o) => o.dependsOnLatentSupply)
    .reduce((a, o) => a + o.estimatedSocialSurplus, 0);
  const multimodalValue = totalValue - latentValue;

  const byMode: Record<string, number> = {};
  for (const o of opportunities) {
    const mode = o.dependsOnLatentSupply ? "latent-supply" : "transit";
    byMode[mode] = (byMode[mode] ?? 0) + 1;
  }

  const byHour: Record<number, number> = {};
  for (const o of opportunities) {
    const h = Math.floor(o.departureSec / 3600);
    byHour[h] = (byHour[h] ?? 0) + 1;
  }

  // curves
  const phCurve = planningHorizonCurve(demands, latent, baselineResult.perDemand, nodes, config, dataSources);
  const densCurve = densityCurve(demands, baselineResult.perDemand, nodes, config, dataSources, config.seed);

  // data quality warnings
  const warnings: string[] = [
    "All data is fixture/synthetic — results are real MEASUREMENTS of the fixture, not empirical facts about Accra.",
    "Movement trajectories are generated, not observed. Real movement data is required to validate opportunity density.",
    "Latent supply (Layer B) is entirely inferred from assumptions — capacity, willingness, and execution probability are not measured.",
    "Transit feed is a GTFS-shaped fixture. Real GTFS from a transit agency is required for real schedule feasibility.",
    "No GTFS-Realtime — delays are null. Real-time feeds would change opportunity confidence.",
  ];

  const stats = describe(values.length > 0 ? values : [0]);

  return {
    config,
    pilot,
    datasets: dataSources,
    demands,
    movements,
    latentSupply: latent,
    opportunities,
    baseline: baselineResult,
    metrics: {
      totalDemands: demands.length,
      feasibleOpportunities: feasibleOpps.length,
      economicallyAttractive: economicOpps.length,
      highConfidence: highConfOpps.length,
      opportunitiesPer1000: oppPer1000,
      medianValue: stats.median,
      p25Value: stats.p25,
      p75Value: stats.p75,
      totalEstimatedValue: Math.round(totalValue * 100) / 100,
      multimodalRoutingValue: Math.round(multimodalValue * 100) / 100,
      latentSupplyDiscoveryValue: Math.round(latentValue * 100) / 100,
      byMode,
      byHour,
    },
    planningHorizonCurve: phCurve,
    densityCurve: densCurve,
    topOpportunities: opportunities.slice(0, 12),
    dataQualityWarnings: warnings,
    assumptions,
    generatedAt: new Date().toISOString(),
  };
}
