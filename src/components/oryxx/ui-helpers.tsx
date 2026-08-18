"use client";

import {
  Footprints,
  Bus,
  TrainFront,
  Ship,
  Car,
  Truck,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Mode, PlanTag } from "@/lib/oryxx/types";

export const MODE_ICON: Record<Mode, LucideIcon> = {
  walk: Footprints,
  bus: Bus,
  train: TrainFront,
  ferry: Ship,
  rideshare: Car,
  carpool: Users,
  freight: Truck,
};

export const MODE_LABEL: Record<Mode, string> = {
  walk: "Walk",
  bus: "Bus",
  train: "Train",
  ferry: "Ferry",
  rideshare: "Rideshare",
  carpool: "Carpool",
  freight: "Freight",
};

export const MODE_COLOR: Record<Mode, string> = {
  walk: "text-stone-500 bg-stone-500/10 border-stone-500/20",
  bus: "text-amber-600 bg-amber-500/10 border-amber-500/30",
  train: "text-emerald-600 bg-emerald-500/10 border-emerald-500/30",
  ferry: "text-teal-600 bg-teal-500/10 border-teal-500/30",
  rideshare: "text-rose-600 bg-rose-500/10 border-rose-500/30",
  carpool: "text-violet-600 bg-violet-500/10 border-violet-500/30",
  freight: "text-orange-700 bg-orange-500/10 border-orange-500/30",
};

export const TAG_META: Record<
  PlanTag,
  { label: string; badge: string; ring: string }
> = {
  best_overall: {
    label: "Best overall",
    badge: "bg-emerald-600 text-white",
    ring: "ring-2 ring-emerald-500/60",
  },
  cheapest: {
    label: "Cheapest",
    badge: "bg-amber-500 text-white",
    ring: "ring-1 ring-amber-500/40",
  },
  fastest: {
    label: "Fastest",
    badge: "bg-sky-600 text-white",
    ring: "ring-1 ring-sky-500/40",
  },
  most_reliable: {
    label: "Most reliable",
    badge: "bg-teal-600 text-white",
    ring: "ring-1 ring-teal-500/40",
  },
  interesting_alternative: {
    label: "Interesting alternative",
    badge: "bg-violet-600 text-white",
    ring: "ring-1 ring-violet-500/40",
  },
};

export function confidenceColor(c: number): string {
  if (c >= 0.9) return "text-emerald-600";
  if (c >= 0.75) return "text-amber-600";
  return "text-rose-600";
}

export function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function onTimeColor(p: number): string {
  if (p >= 0.9) return "text-emerald-600";
  if (p >= 0.75) return "text-amber-600";
  return "text-rose-600";
}
