// ORYXX — Market regimes (configurable simulation scenarios).
// Each regime has explicit parameters. The UI lists these so experiments are
// reproducible and labelled.

import type { Regime, ExperimentConfig, WorldConfig } from "../canonical/types";
import { DEFAULT_WORLD } from "../canonical/types";

export const REGIMES: Regime[] = [
  {
    id: "sparse-demand",
    name: "Sparse demand",
    description: "Few transportation events relative to supply. Tests whether coordination helps when demand is thin.",
    config: { numDemands: 50, numDrivers: 80, numNPDs: 30, numTrucks: 20, numTransitLines: 5 },
    world: {},
  },
  {
    id: "dense-demand",
    name: "Dense demand",
    description: "Many transportation events. Tests for network effects and congestion.",
    config: { numDemands: 800, numDrivers: 80, numNPDs: 50, numTrucks: 25, numTransitLines: 6 },
    world: {},
  },
  {
    id: "sparse-supply",
    name: "Sparse supply",
    description: "Little supply available. Tests whether ORYXX finds scarce opportunities.",
    config: { numDemands: 300, numDrivers: 20, numNPDs: 10, numTrucks: 5, numTransitLines: 2 },
    world: {},
  },
  {
    id: "dense-latent-supply",
    name: "Dense latent supply",
    description: "Many NPDs. Tests whether latent supply is actually valuable.",
    config: { numDemands: 300, numDrivers: 40, numNPDs: 150, numTrucks: 20, numTransitLines: 5 },
    world: {},
  },
  {
    id: "high-uncertainty",
    name: "High uncertainty",
    description: "Low execution probability + low reliability. Tests risk-adjustment.",
    config: { numDemands: 300, numDrivers: 60, numNPDs: 40, numTrucks: 20, numTransitLines: 5 },
    world: { reliabilityWeight: 0.8 },
  },
  {
    id: "high-reliability",
    name: "High reliability",
    description: "High execution probability + high reliability. Tests whether ORYXX advantage persists when everything is dependable.",
    config: { numDemands: 300, numDrivers: 60, numNPDs: 40, numTrucks: 20, numTransitLines: 5 },
    world: { reliabilityWeight: 0.1 },
  },
  {
    id: "high-transit",
    name: "High transit availability",
    description: "Many transit lines. Tests transit-based opportunities.",
    config: { numDemands: 300, numDrivers: 40, numNPDs: 30, numTrucks: 15, numTransitLines: 12 },
    world: {},
  },
  {
    id: "low-transit",
    name: "Low transit availability",
    description: "Few/no transit lines. Tests whether ORYXX still helps without transit.",
    config: { numDemands: 300, numDrivers: 60, numNPDs: 40, numTrucks: 20, numTransitLines: 0 },
    world: {},
  },
  {
    id: "high-freight",
    name: "High freight mix",
    description: "Many pallet/container demands + trucks. Tests freight backhaul discovery.",
    config: { numDemands: 300, numDrivers: 30, numNPDs: 20, numTrucks: 80, numTransitLines: 3 },
    world: {},
  },
  {
    id: "high-pooling",
    name: "High pooling tolerance",
    description: "Large detour tolerances. Tests whether pooling helps.",
    config: { numDemands: 300, numDrivers: 60, numNPDs: 40, numTrucks: 20, numTransitLines: 5 },
    world: { defaultDetourToleranceKm: 6 },
  },
  {
    id: "low-pooling",
    name: "Low pooling tolerance",
    description: "Small detour tolerances. Tests whether ORYXX advantage survives when riders won't detour.",
    config: { numDemands: 300, numDrivers: 60, numNPDs: 40, numTrucks: 20, numTransitLines: 5 },
    world: { defaultDetourToleranceKm: 0.5 },
  },
  {
    id: "high-deadhead",
    name: "High deadhead ratio",
    description: "Rideshare deadheads back 90% of trip. Amplifies the empty-km waste ORYXX can remove.",
    config: { numDemands: 300, numDrivers: 60, numNPDs: 40, numTrucks: 20, numTransitLines: 5 },
    world: { deadheadRatioRideshare: 0.9, deadheadRatioTruck: 0.8 },
  },
  {
    id: "no-deadhead",
    name: "No deadhead (idealized)",
    description: "Rideshare deadheads 0%. Stress-tests whether ORYXX's empty-km advantage is purely a deadhead artefact.",
    config: { numDemands: 300, numDrivers: 60, numNPDs: 40, numTrucks: 20, numTransitLines: 5 },
    world: { deadheadRatioRideshare: 0, deadheadRatioTruck: 0, repositionRatioAfterDrop: 0 },
  },
  {
    id: "balanced",
    name: "Balanced (default)",
    description: "A balanced mid-density regime with default assumptions.",
    config: { numDemands: 300, numDrivers: 60, numNPDs: 40, numTrucks: 20, numTransitLines: 5 },
    world: {},
  },
];

export function regimeToConfig(regime: Regime, seed: number, numSeeds: number): ExperimentConfig {
  const world: WorldConfig = { ...DEFAULT_WORLD, ...regime.world };
  return {
    seed,
    numSeeds,
    regionKm: 22,
    exactMaxDemands: 16,
    world,
    strategies: ["ordinary", "multimodal", "pooling-fixed", "centralized", "oryxx", "clairvoyant"],
    numDemands: regime.config.numDemands ?? 300,
    numDrivers: regime.config.numDrivers ?? 60,
    numNPDs: regime.config.numNPDs ?? 40,
    numTrucks: regime.config.numTrucks ?? 20,
    numTransitLines: regime.config.numTransitLines ?? 5,
  };
}
