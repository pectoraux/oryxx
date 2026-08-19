// ORYXX — Intent understanding (master prompt §26A).
//
// The LLM's ONLY job here is to turn a free-form transportation intent into a
// strict, validated TransportationEvent JSON. It does NOT decide feasibility —
// the deterministic solver owns that (§26: "Do not make the LLM the source of
// truth for transportation feasibility").
//
// Robustness: if the LLM is unavailable, returns malformed JSON, or violates
// the schema, we fall back to a deterministic heuristic parser so the product
// keeps working.

import type { TransportationEvent, AutonomyLevel, RiskTolerance, ObjectKind } from "./types";
import { parseTimeToMin } from "./world";
import { getZai } from "@/lib/zai";

const SYSTEM_PROMPT = `You are ORYXX's intent parser. You convert a user's natural-language transportation request into a STRICT JSON object representing a Transportation Event.

Output ONLY a JSON object matching exactly this TypeScript shape (no prose, no markdown fences):
{
  "object": { "kind": "person"|"people"|"parcel"|"cargo"|"pallet"|"container"|"vehicle"|"materials"|"agriculture"|"other", "label": string, "count": number, "weightKg"?: number, "fragile"?: boolean, "temperatureControlled"?: boolean, "accessible"?: boolean },
  "origin": string,
  "destination": string,
  "earliestDeparture": "HH:mm" | ISO,
  "preferredDeparture"?: "HH:mm" | ISO,
  "latestArrival"?: "HH:mm" | ISO,
  "constraints": { "budget"?: number, "maxTransfers"?: number, "maxWalkingKm"?: number, "requiresAccessibility"?: boolean, "requiresTemperatureControl"?: boolean, "vehicleRequirements"?: string[] },
  "objectives": { "cost": number, "time": number, "reliability": number, "emissions": number, "comfort": number, "transfers": number, "walking": number, "safety": number },
  "riskTolerance": "risk-averse"|"balanced"|"risk-seeking",
  "autonomy": 0|1|2|3|4|5
}

Rules:
- Infer object.kind from words: "I"/"me"/"myself" => person; "we"/"kids"/"children"/"family"/"people" => people; "box"/"boxes"/"parcel"/"package" => parcel; "pallet" => pallet; "container"/"TEU" => container; "cargo"/"goods"/"freight" => cargo; "materials"/"construction" => materials; "produce"/"agriculture" => agriculture.
- Infer count: "10 boxes" => count 10; "2 people" => count 2; default 1.
- Times: parse "by 8 PM" as latestArrival; "at 7:30"/"leave at" as preferredDeparture; "after 6"/"no earlier than" as earliestDeparture. Use 24h HH:mm. If no time given, default earliestDeparture "08:00".
- Budget: "under $20" => budget 20. Strip currency symbols.
- Objectives weights 0..1. Infer from phrases: "cheapest"/"cheap"/"budget" => cost 1; "fastest"/"quick"/"asap"/"by 8" => time 1; "safest"/"reliable"/"don't be late"/"on time" => reliability 0.9, safety 0.9; "green"/"eco"/"low emissions" => emissions 1; "comfortable"/"no transfers" => comfort 0.9, transfers 0.9; "least walking" => walking 1. Otherwise balanced ~0.5 each (cost 0.7, time 0.7).
- riskTolerance: "safest"/"don't risk" => risk-averse; "don't care"/"flexible"/"whenever" => risk-seeking; else balanced.
- autonomy: "search and book"/"auto"/"just do it" => 4; "keep searching"/"notify"/"watch" => 1 or 5 if "portfolio"; "recommend"/"suggest" => 0; default 1.
- If the user specifies an object that's clearly freight (boxes, pallet, container, cargo), set vehicleRequirements appropriately (e.g. ["van"] for boxes, ["truck"] for pallet/container) and requiresTemperatureControl true if "cold"/"refrigerated"/"frozen".
- NEVER invent a destination or origin. Use the user's place names verbatim.
- Output valid JSON only.`;

export interface ParseResult {
  event: TransportationEvent;
  parsedBy: "llm" | "heuristic";
}

export async function parseIntent(raw: string): Promise<ParseResult> {
  const trimmed = raw.trim();
  if (!trimmed) return { event: heuristicParse(""), parsedBy: "heuristic" };

  try {
    const zai = await getZai();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "assistant", content: SYSTEM_PROMPT },
        { role: "user", content: trimmed },
      ],
      thinking: { type: "disabled" },
    });
    const content = completion.choices[0]?.message?.content ?? "";
    const json = extractJson(content);
    if (json) {
      const event = validateAndCoerce(json, trimmed);
      if (event) return { event, parsedBy: "llm" };
    }
  } catch (err) {
    // fall through to heuristic
    console.error("[oryxx] LLM parse failed, using heuristic:", (err as Error)?.message);
  }
  return { event: heuristicParse(trimmed), parsedBy: "heuristic" };
}

function extractJson(text: string): any | null {
  if (!text) return null;
  // strip code fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function clamp01(n: any): number {
  const v = Number(n);
  if (!isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

function validateAndCoerce(j: any, raw: string): TransportationEvent | null {
  try {
    if (!j || typeof j !== "object") return null;
    const obj = j.object ?? { kind: "person", label: "1 person", count: 1 };
    const kind = (obj.kind as ObjectKind) ?? "person";
    const event: TransportationEvent = {
      object: {
        kind,
        label: String(obj.label ?? defaultLabel(kind, obj.count ?? 1)),
        count: Number(obj.count ?? 1) || 1,
        weightKg: obj.weightKg != null ? Number(obj.weightKg) : undefined,
        fragile: obj.fragile ?? undefined,
        temperatureControlled: obj.temperatureControlled ?? undefined,
        accessible: obj.accessible ?? undefined,
      },
      origin: String(j.origin ?? "").trim(),
      destination: String(j.destination ?? "").trim(),
      earliestDeparture: normalizeTime(j.earliestDeparture) ?? "08:00",
      preferredDeparture: normalizeTime(j.preferredDeparture) ?? undefined,
      latestArrival: normalizeTime(j.latestArrival) ?? undefined,
      constraints: {
        budget: j.constraints?.budget != null ? Number(j.constraints.budget) : undefined,
        maxTransfers: j.constraints?.maxTransfers != null ? Number(j.constraints.maxTransfers) : undefined,
        maxWalkingKm: j.constraints?.maxWalkingKm != null ? Number(j.constraints.maxWalkingKm) : undefined,
        requiresAccessibility: j.constraints?.requiresAccessibility ?? undefined,
        requiresTemperatureControl: j.constraints?.requiresTemperatureControl ?? undefined,
        vehicleRequirements: Array.isArray(j.constraints?.vehicleRequirements) ? j.constraints.vehicleRequirements : undefined,
      },
      objectives: {
        cost: clamp01(j.objectives?.cost ?? 0.7),
        time: clamp01(j.objectives?.time ?? 0.7),
        reliability: clamp01(j.objectives?.reliability ?? 0.6),
        emissions: clamp01(j.objectives?.emissions ?? 0.35),
        comfort: clamp01(j.objectives?.comfort ?? 0.4),
        transfers: clamp01(j.objectives?.transfers ?? 0.5),
        walking: clamp01(j.objectives?.walking ?? 0.4),
        safety: clamp01(j.objectives?.safety ?? 0.55),
      },
      riskTolerance: (j.riskTolerance as RiskTolerance) ?? "balanced",
      autonomy: ((Number(j.autonomy) as AutonomyLevel) in [0, 1, 2, 3, 4, 5] ? Number(j.autonomy) : 1) as AutonomyLevel,
      rawIntent: raw,
    };
    if (!event.origin || !event.destination) return null;
    return event;
  } catch {
    return null;
  }
}

function defaultLabel(kind: ObjectKind, count: number): string {
  const map: Record<ObjectKind, string> = {
    person: "1 person",
    people: `${count} people`,
    parcel: `${count} ${count === 1 ? "parcel" : "parcels"}`,
    cargo: "cargo",
    pallet: `${count} ${count === 1 ? "pallet" : "pallets"}`,
    container: `${count} container`,
    vehicle: "vehicle",
    materials: "materials",
    agriculture: "agricultural goods",
    other: "item",
  };
  return map[kind] ?? "1 person";
}

function normalizeTime(t: any): string | undefined {
  if (t == null) return undefined;
  const s = String(t).trim();
  // already HH:mm
  if (/^\d{1,2}:\d{2}/.test(s)) {
    const m = parseTimeToMin(s.slice(0, 5));
    if (m != null) {
      const h = Math.floor(m / 60);
      const mm = m % 60;
      return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    }
  }
  // ISO
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const m = d.getHours() * 60 + d.getMinutes();
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }
  // 12h like "8 PM", "7:30 am"
  const ampm = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const min = ampm[2] ? parseInt(ampm[2], 10) : 0;
    const ap = ampm[3].toLowerCase();
    if (ap === "pm" && h !== 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }
  return undefined;
}

// --- Heuristic fallback parser ---------------------------------------------
// Deterministic. Good enough to keep the product usable if the LLM is down.
export function heuristicParse(raw: string): TransportationEvent {
  const s = raw.toLowerCase();
  const kind: ObjectKind = /box|boxes|parcel|package/.test(s)
    ? "parcel"
    : /pallet/.test(s)
    ? "pallet"
    : /container|teu/.test(s)
    ? "container"
    : /cargo|goods|freight/.test(s)
    ? "cargo"
    : /materials|construction|cement|steel|bricks/.test(s)
    ? "materials"
    : /produce|vegetables|fruit|agriculture/.test(s)
    ? "agriculture"
    : /we|us|kids|children|family|people|team|friends/.test(s)
    ? "people"
    : "person";

  const countMatch = raw.match(/(\d+)\s*(?:people|persons|pax|seats|boxes|parcels|packages|pallets|containers|teu|tons|kg)/i);
  const count = countMatch ? parseInt(countMatch[1], 10) : /we|kids|children|family/.test(s) ? 2 : 1;

  const budgetMatch = raw.match(/(?:under|below|max|budget|\$|€|£|₵|ghs?)\s*(\d+(?:\.\d+)?)/i);
  const budget = budgetMatch ? Number(budgetMatch[1]) : undefined;

  const latest = matchTime(s, /by\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i) || matchTime(s, /before\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  const preferred = matchTime(s, /(?:leave|depart|at|after)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  const earliest = matchTime(s, /(?:after|no earlier than|from)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);

  const originDest = extractOriginDest(raw);

  const objectives = {
    cost: /cheap|cheapest|budget|affordable|under \$|least cost/.test(s) ? 1 : 0.7,
    time: /fast|fastest|quick|asap|by \d|on time|don't be late/.test(s) ? 1 : 0.7,
    reliability: /safest|reliable|on time|don't be late|guarantee/.test(s) ? 0.95 : 0.6,
    emissions: /green|eco|emission|carbon|environment/.test(s) ? 1 : 0.35,
    comfort: /comfortable|no transfer|direct|easy/.test(s) ? 0.9 : 0.4,
    transfers: /no transfer|fewest transfer|direct/.test(s) ? 0.9 : /fewer transfer/.test(s) ? 0.7 : 0.5,
    walking: /least walking|no walking|minimal walking/.test(s) ? 1 : 0.4,
    safety: /safest|safe|secure|trusted/.test(s) ? 1 : 0.55,
  };

  const riskTolerance: RiskTolerance = /safest|don't risk|reliable|guarantee|on time/.test(s)
    ? "risk-averse"
    : /don't care|whenever|flexible|anytime/.test(s)
    ? "risk-seeking"
    : "balanced";

  let autonomy: AutonomyLevel = 1;
  if (/just (do|book) it|auto|automatically|search and book/.test(s)) autonomy = 4;
  else if (/keep searching|watch|notify|portfolio|continuously/.test(s)) autonomy = 5;
  else if (/recommend|suggest|what should/.test(s)) autonomy = 0;

  const requiresTemperatureControl = /cold|refrigerat|frozen|chilled|perishable/.test(s);
  const vehicleRequirements: string[] | undefined = kind === "pallet" || kind === "container" || kind === "cargo" ? ["truck"] : kind === "parcel" && count > 5 ? ["van"] : undefined;

  return {
    object: { kind, label: defaultLabel(kind, count), count, temperatureControlled: requiresTemperatureControl || undefined },
    origin: originDest.origin,
    destination: originDest.destination,
    earliestDeparture: earliest ?? "08:00",
    preferredDeparture: preferred ?? undefined,
    latestArrival: latest ?? undefined,
    constraints: { budget, maxTransfers: undefined, maxWalkingKm: undefined, requiresTemperatureControl: requiresTemperatureControl || undefined, vehicleRequirements },
    objectives,
    riskTolerance,
    autonomy,
    rawIntent: raw,
  };
}

function matchTime(s: string, re: RegExp): string | undefined {
  const m = s.match(re);
  if (!m) return undefined;
  return normalizeTime(m[1]);
}

// Pull "from X to Y" / "X to Y" / "X -> Y" out of the sentence.
function extractOriginDest(raw: string): { origin: string; destination: string } {
  const patterns = [
    /from\s+(.+?)\s+to\s+(.+?)(?:\s+(?:by|at|after|before|under|leave|depart)|[.,;]|$)/i,
    /(.+?)\s*(?:->|→|to)\s+(.+?)(?:\s+(?:by|at|after|before|under|leave|depart)|[.,;]|$)/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m && m[1] && m[2]) {
      const origin = cleanPlace(m[1]);
      const destination = cleanPlace(m[2]);
      if (origin && destination) return { origin, destination };
    }
  }
  return { origin: "", destination: "" };
}

function cleanPlace(s: string): string {
  return s.replace(/^(the|my|our)\s+/i, "").replace(/[.,;]+$/g, "").trim();
}
