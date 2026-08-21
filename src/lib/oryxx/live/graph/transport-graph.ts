// ORYXX — Global Transportation Graph
//
// A provider-neutral, crowd-sourced, multi-modal transportation graph that
// models the physical world's roads, transit lines, walking connections,
// freight routes, and transfer points. The graph is the spatial backbone of
// the live marketplace: every demand, supply, opportunity, and execution is
// ultimately anchored to nodes and edges in this graph.
//
// DESIGN PRINCIPLES
//
//   1. Provenance on every object. Every GraphNode and GraphEdge carries
//      `source`, `observedAt`, and `confidence`. A node imported from GTFS
//      has source "gtfs" and observedAt = the feed's timestamp; a node
//      contributed by a direct-user observation has source "direct-user"
//      and confidence = the reporter's trust score. This is what lets the
//      marketplace distinguish verified infrastructure from inferred /
//      assumed infrastructure.
//
//   2. Haversine for proximity. All "near" queries use great-circle distance
//      (haversineKm), not Euclidean on a projected plane. This is correct
//      for a global graph where nodes span hemispheres.
//
//   3. Multi-modal edges. A single graph can hold road, transit, walking,
//      freight-route, and transfer edges. Transfer edges are zero-distance
//      connectors between modes at the same physical location (e.g. a bus
//      stop and a metro platform that share a node).
//
//   4. Path finding is bounded. findRoutes() enumerates simple paths (no
//      repeated nodes) up to a configurable max length to prevent
//      exponential blowup on dense graphs. The default cap is 5 edges,
//      which is sufficient for any realistic multi-modal journey (3
//      transfers + 2 vehicle legs).
//
//   5. The graph is mutation-safe. addNode and addEdge are idempotent on
//      ID — adding a node with an existing ID updates it in place; adding
//      an edge with an existing ID updates it in place. This lets
//      crowd-sourced observations refine the graph without version skew.
//
// This module is purely about SPATIAL / TOPOLOGICAL structure. It does NOT
// know about marketplace concepts (demand, supply, opportunity). The
// `findSupplyNear` and `findDemandNear` helpers are semantic conveniences
// that filter by node type; the actual demand/supply objects live in the
// marketplace layer.

import type {
  EdgeType,
  GeoPoint,
  GraphEdge,
  GraphNode,
  GraphNodeType,
  ProvenanceSource,
} from "../types";

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Graph version — bumped on any change to the path-finding algorithm or
 * proximity semantics so downstream consumers can detect drift.
 */
export const TRANSPORT_GRAPH_VERSION = "oryxx-graph-v1.0.0";

/**
 * Default cap on the number of edges in a simple path returned by
 * findRoutes(). 5 edges = up to 4 transfers, which is more than any
 * realistic multi-modal journey. Callers can override via the
 * maxPathLength parameter to findRoutes().
 *
 * Without a cap, simple-path enumeration on a dense graph is exponential
 * and can hang the process. The cap is a hard safety bound.
 */
export const DEFAULT_MAX_PATH_LENGTH = 5;

/**
 * Default detour tolerance (km) used by findOpportunityEdges() when no
 * explicit tolerance is supplied. A supply node is "feasible" for a demand
 * node if the great-circle distance between them is at most this many
 * kilometers. 50 km is a generous default that captures intra-region
 * freight movements and inter-city rideshare; callers with tighter
 * constraints should pass an explicit tolerance.
 */
export const DEFAULT_OPPORTUNITY_TOLERANCE_KM = 50;

/**
 * Node types that semantically represent supply-relevant locations:
 * depots (where vehicles are staged) and hubs (where supply aggregates).
 * Used by findSupplyNear() as a default type filter.
 */
const SUPPLY_NODE_TYPES: ReadonlySet<GraphNodeType> = new Set([
  "depot",
  "hub",
]);

/**
 * Node types that semantically represent demand-relevant locations: where
 * people or goods originate or terminate. Used by findDemandNear() as a
 * default type filter. Hubs appear in BOTH sets because a hub is both a
 * supply aggregation point and a demand origin/destination.
 */
const DEMAND_NODE_TYPES: ReadonlySet<GraphNodeType> = new Set([
  "terminal",
  "stop",
  "city",
  "zone",
  "hub",
]);

/**
 * Node types that can serve as transfer points between modes. A transfer
 * point is a place where a traveler or shipment can switch from one vehicle
 * / mode to another — typically a hub, terminal, or stop. findTransferPoints
 * uses this set as a default filter.
 */
const TRANSFER_NODE_TYPES: ReadonlySet<GraphNodeType> = new Set([
  "hub",
  "terminal",
  "stop",
]);

// ═══════════════════════════════════════════════════════════════════════
// GEOMETRY (haversine great-circle distance)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Great-circle distance between two lat/lon points, in kilometers. Uses the
 * haversine formula with Earth radius R = 6371 km.
 *
 * This is a local copy of the function defined in
 * engine/opportunity-engine.ts. The graph module is architecturally
 * lower-level than the engine module (the engine depends on the graph, not
 * vice versa), so we duplicate the 6-line haversine here rather than
 * create an upward import.
 *
 * @param a  First point.
 * @param b  Second point.
 * @returns  Distance in kilometers, >= 0.
 */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371; // Earth radius (km)
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ═══════════════════════════════════════════════════════════════════════
// ID GENERATION
// ═══════════════════════════════════════════════════════════════════════

let nodeCounter = 0;
let edgeCounter = 0;

/**
 * Generate a unique GraphNode ID. Prefixed "NODE-" and suffixed with an
 * in-process counter. For deterministic IDs (e.g. tied to a GTFS stop_id),
 * callers should pass their own ID via createNodeWithId() or set the ID
 * field directly on the node object.
 */
function nextNodeId(): string {
  nodeCounter += 1;
  return `NODE-${nodeCounter}`;
}

/**
 * Generate a unique GraphEdge ID. Prefixed "EDGE-" and suffixed with an
 * in-process counter plus the from/to node IDs, so audit logs read like:
 *   EDGE-{fromNodeId}->{toNodeId}-{counter}
 */
function nextEdgeId(fromNodeId: string, toNodeId: string): string {
  edgeCounter += 1;
  return `EDGE-${fromNodeId}->${toNodeId}-${edgeCounter}`;
}

// ═══════════════════════════════════════════════════════════════════════
// NODE + EDGE FACTORIES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a new GraphNode. The node's `observedAt` is set to the current
 * ISO timestamp; callers can override via the optional `observedAt`
 * parameter (e.g. when importing a GTFS feed with its own timestamp).
 *
 * Confidence is clamped to [0, 1].
 *
 * @param type         The node's type (region / city / zone / stop / hub /
 *                     depot / terminal / intersection).
 * @param point        The node's geographic location.
 * @param name         Optional human-readable name (e.g. "Union Station").
 * @param source       The provenance source — who/what observed this node.
 * @param confidence    0..1 confidence in the node's existence and location.
 * @param observedAt   Optional ISO timestamp override (defaults to now).
 * @param validFrom    Optional ISO timestamp when the node becomes valid.
 * @param validTo      Optional ISO timestamp when the node ceases to be valid.
 * @returns            A new GraphNode.
 */
export function createNode(
  type: GraphNodeType,
  point: GeoPoint,
  name: string | undefined,
  source: ProvenanceSource,
  confidence: number,
  observedAt?: string,
  validFrom?: string,
  validTo?: string,
): GraphNode {
  return {
    id: nextNodeId(),
    type,
    point: { lat: point.lat, lon: point.lon, name: name ?? point.name },
    name,
    source,
    observedAt: observedAt ?? new Date().toISOString(),
    validFrom,
    validTo,
    confidence: clampUnit(confidence),
  };
}

/**
 * Create a new GraphEdge between two nodes. The edge's `observedAt` is set
 * to the current ISO timestamp; callers can override.
 *
 * The from/to nodes are passed BY REFERENCE (not by ID) so that this factory
 * can compute a default `distanceKm` from their geographic points when the
 * caller doesn't supply one. If `distanceKm` is provided, it is used as-is
 * (e.g. for a road segment that follows a non-geodesic path); otherwise the
 * great-circle distance between the two nodes is used.
 *
 * If `travelTimeSec` is not provided, it is estimated from distanceKm using
 * a default urban speed of 30 km/h. Callers with mode-specific speed
 * models should pass travelTimeSec explicitly.
 *
 * @param fromNode        The source node.
 * @param toNode          The destination node.
 * @param type            The edge type (road / transit / walking /
 *                        freight-route / transfer).
 * @param distanceKm      Optional distance in km. If omitted, computed
 *                        via haversine from the nodes' points.
 * @param travelTimeSec   Optional travel time in seconds. If omitted,
 *                        estimated from distanceKm at 30 km/h.
 * @param source          Provenance source — who/what observed this edge.
 * @param confidence      0..1 confidence in the edge's existence and metrics.
 * @param observedAt      Optional ISO timestamp override.
 * @returns               A new GraphEdge.
 */
export function createEdge(
  fromNode: GraphNode,
  toNode: GraphNode,
  type: EdgeType,
  distanceKm: number | undefined,
  travelTimeSec: number | undefined,
  source: ProvenanceSource,
  confidence: number,
  observedAt?: string,
): GraphEdge {
  const dist =
    typeof distanceKm === "number"
      ? Math.max(distanceKm, 0)
      : Math.max(haversineKm(fromNode.point, toNode.point), 0);

  // Default speed: 30 km/h (urban mixed-mode). Walking edges should pass
  // an explicit travelTimeSec; this default is a rough estimate.
  const time =
    typeof travelTimeSec === "number"
      ? Math.max(travelTimeSec, 0)
      : dist > 0
        ? Math.round((dist / 30) * 3600)
        : 0;

  return {
    id: nextEdgeId(fromNode.id, toNode.id),
    fromNodeId: fromNode.id,
    toNodeId: toNode.id,
    type,
    distanceKm: Math.round(dist * 1000) / 1000, // round to meters
    travelTimeSec: Math.round(time),
    source,
    observedAt: observedAt ?? new Date().toISOString(),
    confidence: clampUnit(confidence),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// TRANSPORT GRAPH
// ═══════════════════════════════════════════════════════════════════════

/**
 * The global transportation graph. Holds nodes and edges, indexed by ID for
 * O(1) lookup, with adjacency lists for fast traversal.
 *
 * The graph is DIRECTED: an edge from A to B does not imply an edge from B
 * to A. Callers representing bidirectional roads / routes should add edges
 * in both directions (or use addBidirectionalEdge()).
 *
 * The graph is IN-MEMORY and not thread-safe. For shared deployments,
 * callers should serialize mutations through a single writer.
 */
export class TransportGraph {
  /** Nodes indexed by ID. */
  private readonly nodes: Map<string, GraphNode> = new Map();
  /** Edges indexed by ID. */
  private readonly edges: Map<string, GraphEdge> = new Map();
  /** Adjacency list: nodeId -> outgoing edges. */
  private readonly adjacency: Map<string, GraphEdge[]> = new Map();
  /** Reverse adjacency: nodeId -> incoming edges (for potential future use). */
  private readonly reverseAdjacency: Map<string, GraphEdge[]> = new Map();

  // ── MUTATION ────────────────────────────────────────────────────────

  /**
   * Add a node to the graph. If a node with the same ID already exists, it
   * is replaced (in-place update) — this lets crowd-sourced observations
   * refine node confidence / location over time without ID skew.
   */
  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
    if (!this.adjacency.has(node.id)) {
      this.adjacency.set(node.id, []);
    }
    if (!this.reverseAdjacency.has(node.id)) {
      this.reverseAdjacency.set(node.id, []);
    }
  }

  /**
   * Add an edge to the graph. Both endpoint nodes MUST already exist (call
   * addNode() first); otherwise an Error is thrown. If an edge with the
   * same ID already exists, it is replaced.
   *
   * Self-loops (from === to) are permitted (e.g. a "transfer" edge that
   * represents a same-location mode switch modeled as a degenerate edge).
   */
  addEdge(edge: GraphEdge): void {
    if (!this.nodes.has(edge.fromNodeId)) {
      throw new Error(
        `Cannot add edge ${edge.id}: from-node ${edge.fromNodeId} does not exist.`,
      );
    }
    if (!this.nodes.has(edge.toNodeId)) {
      throw new Error(
        `Cannot add edge ${edge.id}: to-node ${edge.toNodeId} does not exist.`,
      );
    }
    this.edges.set(edge.id, edge);
    const out = this.adjacency.get(edge.fromNodeId) ?? [];
    out.push(edge);
    this.adjacency.set(edge.fromNodeId, out);
    const inc = this.reverseAdjacency.get(edge.toNodeId) ?? [];
    inc.push(edge);
    this.reverseAdjacency.set(edge.toNodeId, inc);
  }

  /**
   * Convenience: add an edge in BOTH directions (A->B and B->A) with the
   * same metrics. Useful for bidirectional roads. Returns the two created
   * edges. Both edges share the same source / confidence / observedAt.
   */
  addBidirectionalEdge(
    fromNode: GraphNode,
    toNode: GraphNode,
    type: EdgeType,
    distanceKm: number | undefined,
    travelTimeSec: number | undefined,
    source: ProvenanceSource,
    confidence: number,
  ): [GraphEdge, GraphEdge] {
    const forward = createEdge(
      fromNode,
      toNode,
      type,
      distanceKm,
      travelTimeSec,
      source,
      confidence,
    );
    const reverse = createEdge(
      toNode,
      fromNode,
      type,
      distanceKm,
      travelTimeSec,
      source,
      confidence,
    );
    this.addEdge(forward);
    this.addEdge(reverse);
    return [forward, reverse];
  }

  // ── BASIC LOOKUP ────────────────────────────────────────────────────

  /** Get a node by ID, or undefined. */
  getNode(nodeId: string): GraphNode | undefined {
    return this.nodes.get(nodeId);
  }

  /** Get an edge by ID, or undefined. */
  getEdge(edgeId: string): GraphEdge | undefined {
    return this.edges.get(edgeId);
  }

  /** All nodes in the graph (insertion order). */
  allNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  /** All edges in the graph (insertion order). */
  allEdges(): GraphEdge[] {
    return Array.from(this.edges.values());
  }

  /** Number of nodes. */
  nodeCount(): number {
    return this.nodes.size;
  }

  /** Number of edges. */
  edgeCount(): number {
    return this.edges.size;
  }

  /**
   * Outgoing edges from a node. Returns an empty array if the node doesn't
   * exist or has no outgoing edges.
   */
  outgoingEdges(nodeId: string): GraphEdge[] {
    return this.adjacency.get(nodeId) ?? [];
  }

  /**
   * Incoming edges to a node. Returns an empty array if the node doesn't
   * exist or has no incoming edges.
   */
  incomingEdges(nodeId: string): GraphEdge[] {
    return this.reverseAdjacency.get(nodeId) ?? [];
  }

  // ── ROUTE FINDING ───────────────────────────────────────────────────

  /**
   * Find all SIMPLE paths (no repeated nodes) from fromNodeId to toNodeId,
   * up to a maximum path length (in edges). Returns a list of paths, where
   * each path is a list of GraphEdge objects traversed in order.
   *
   * Uses depth-first search with backtracking. The maxPathLength cap
   * prevents exponential blowup on dense graphs — without it, the number
   * of simple paths between two nodes can be O(n!) in the worst case.
   *
   * If fromNodeId === toNodeId, returns a single empty path (the trivial
   * "stay here" path). If either node doesn't exist, returns an empty array.
   *
   * The returned paths are NOT sorted — callers should rank them by their
   * own criteria (total distance, total time, number of transfers, etc.).
   * A common ranking is: fewest edges first, then shortest total distance.
   *
   * @param fromNodeId      Source node ID.
   * @param toNodeId        Destination node ID.
   * @param maxPathLength   Maximum number of edges in a path. Defaults to
   *                        DEFAULT_MAX_PATH_LENGTH (5).
   * @returns               Array of paths, each a GraphEdge[].
   */
  findRoutes(
    fromNodeId: string,
    toNodeId: string,
    maxPathLength: number = DEFAULT_MAX_PATH_LENGTH,
  ): GraphEdge[][] {
    // Validate endpoints.
    if (!this.nodes.has(fromNodeId) || !this.nodes.has(toNodeId)) {
      return [];
    }

    // Trivial case: same node.
    if (fromNodeId === toNodeId) {
      return [[]];
    }

    const paths: GraphEdge[][] = [];
    const visited = new Set<string>([fromNodeId]);

    // DFS with backtracking. The `currentPath` accumulates edges; on
    // reaching toNodeId, a snapshot of currentPath is pushed to `paths`.
    const dfs = (currentNodeId: string, currentPath: GraphEdge[]): void => {
      if (currentPath.length >= maxPathLength) return;
      const out = this.adjacency.get(currentNodeId) ?? [];
      for (const edge of out) {
        if (visited.has(edge.toNodeId)) continue;
        if (edge.toNodeId === toNodeId) {
          // Found a path. Snapshot it.
          paths.push([...currentPath, edge]);
          continue;
        }
        // Recurse.
        visited.add(edge.toNodeId);
        currentPath.push(edge);
        dfs(edge.toNodeId, currentPath);
        currentPath.pop();
        visited.delete(edge.toNodeId);
      }
    };

    dfs(fromNodeId, []);
    return paths;
  }

  /**
   * Find the SHORTEST path (by total distance) between two nodes, using
   * Dijkstra's algorithm. Returns null if no path exists.
   *
   * This is a more focused query than findRoutes(): it returns a single
   * optimal path rather than enumerating all simple paths. Use this when
   * you need THE answer; use findRoutes() when you need a menu of options
   * (e.g. for a multi-modal planner that ranks alternatives).
   *
   * Edge weights are distanceKm (>= 0). Transfer edges (distanceKm = 0)
   * contribute zero distance, modeling same-location mode switches.
   */
  findShortestRoute(
    fromNodeId: string,
    toNodeId: string,
  ): GraphEdge[] | null {
    if (!this.nodes.has(fromNodeId) || !this.nodes.has(toNodeId)) {
      return null;
    }
    if (fromNodeId === toNodeId) return [];

    // Dijkstra with a simple priority queue (array-based; fine for
    // graphs up to ~10k nodes — for larger graphs, swap in a binary heap).
    const dist = new Map<string, number>();
    const prev = new Map<string, { node: string; edge: GraphEdge } | null>();
    const visited = new Set<string>();

    for (const id of this.nodes.keys()) {
      dist.set(id, Infinity);
      prev.set(id, null);
    }
    dist.set(fromNodeId, 0);

    while (visited.size < this.nodes.size) {
      // Pick the unvisited node with the smallest tentative distance.
      let currentId: string | null = null;
      let currentDist = Infinity;
      for (const [id, d] of dist) {
        if (!visited.has(id) && d < currentDist) {
          currentId = id;
          currentDist = d;
        }
      }
      if (currentId === null || currentDist === Infinity) break;
      if (currentId === toNodeId) break;

      visited.add(currentId);

      const out = this.adjacency.get(currentId) ?? [];
      for (const edge of out) {
        if (visited.has(edge.toNodeId)) continue;
        const alt = currentDist + Math.max(edge.distanceKm, 0);
        if (alt < (dist.get(edge.toNodeId) ?? Infinity)) {
          dist.set(edge.toNodeId, alt);
          prev.set(edge.toNodeId, { node: currentId, edge });
        }
      }
    }

    // Reconstruct the path.
    const path: GraphEdge[] = [];
    let cursor: { node: string; edge: GraphEdge } | null | undefined =
      prev.get(toNodeId);
    while (cursor) {
      path.unshift(cursor.edge);
      cursor = prev.get(cursor.node) ?? null;
    }

    // If the path is empty and fromNodeId !== toNodeId, there's no path.
    if (path.length === 0 && fromNodeId !== toNodeId) {
      // Verify: was toNodeId reached at all? If dist[toNodeId] is Infinity,
      // it was never reached.
      if ((dist.get(toNodeId) ?? Infinity) === Infinity) return null;
    }
    return path;
  }

  // ── PROXIMITY QUERIES (haversine) ──────────────────────────────────

  /**
   * Find all nodes within `radiusKm` of the given node, by great-circle
   * distance. The node itself is excluded from the result (distance 0).
   *
   * Optionally filter by node type — e.g. only return hubs / terminals /
   * depots within the radius.
   *
   * @param nodeId       The center node.
   * @param radiusKm     Search radius in kilometers.
   * @param typeFilter   Optional set of node types to include.
   * @returns            Array of GraphNodes within the radius, sorted by
   *                     ascending distance. Empty if the center node
   *                     doesn't exist.
   */
  findNear(
    nodeId: string,
    radiusKm: number,
    typeFilter?: ReadonlySet<GraphNodeType>,
  ): GraphNode[] {
    const center = this.nodes.get(nodeId);
    if (!center) return [];

    const results: { node: GraphNode; distanceKm: number }[] = [];
    for (const candidate of this.nodes.values()) {
      if (candidate.id === nodeId) continue;
      if (typeFilter && !typeFilter.has(candidate.type)) continue;
      const d = haversineKm(center.point, candidate.point);
      if (d <= radiusKm) {
        results.push({ node: candidate, distanceKm: d });
      }
    }
    results.sort((a, b) => a.distanceKm - b.distanceKm);
    return results.map((r) => r.node);
  }

  /**
   * Find transfer points within `radiusKm` of a given node. A "transfer
   * point" is a node where a traveler or shipment can switch modes —
   * typically a hub, terminal, or stop. The center node itself is excluded.
   *
   * This is the canonical query for multi-modal route planning: given a
   * demand's origin node, find nearby transfer points where the journey
   * could switch from (say) rideshare to transit.
   *
   * @param nodeId     The center node.
   * @param radiusKm   Search radius in kilometers.
   * @returns           Transfer-capable nodes within the radius, sorted by
   *                    ascending distance.
   */
  findTransferPoints(nodeId: string, radiusKm: number): GraphNode[] {
    return this.findNear(nodeId, radiusKm, TRANSFER_NODE_TYPES);
  }

  /**
   * Find supply-relevant nodes (depots, hubs) within `radiusKm` of a
   * geographic point. Used by the opportunity engine to discover latent
   * supply that could serve a demand.
   *
   * The point need not be a node in the graph — this query works on raw
   * lat/lon. This is the canonical "find supply near demand origin" query.
   *
   * @param point      The center point (typically a demand's origin).
   * @param radiusKm   Search radius in kilometers.
   * @returns          Supply-relevant nodes within the radius, sorted by
   *                   ascending distance.
   */
  findSupplyNear(point: GeoPoint, radiusKm: number): GraphNode[] {
    const results: { node: GraphNode; distanceKm: number }[] = [];
    for (const candidate of this.nodes.values()) {
      if (!SUPPLY_NODE_TYPES.has(candidate.type)) continue;
      const d = haversineKm(point, candidate.point);
      if (d <= radiusKm) {
        results.push({ node: candidate, distanceKm: d });
      }
    }
    results.sort((a, b) => a.distanceKm - b.distanceKm);
    return results.map((r) => r.node);
  }

  /**
   * Find demand-relevant nodes (terminals, stops, cities, zones, hubs)
   * within `radiusKm` of a geographic point. Used by the opportunity engine
   * to discover demand concentrations that could be served by a supply
   * (e.g. "this truck passes near 3 demand clusters on its route").
   *
   * @param point      The center point (typically a supply's current
   *                   location or a waypoint).
   * @param radiusKm   Search radius in kilometers.
   * @returns          Demand-relevant nodes within the radius, sorted by
   *                   ascending distance.
   */
  findDemandNear(point: GeoPoint, radiusKm: number): GraphNode[] {
    const results: { node: GraphNode; distanceKm: number }[] = [];
    for (const candidate of this.nodes.values()) {
      if (!DEMAND_NODE_TYPES.has(candidate.type)) continue;
      const d = haversineKm(point, candidate.point);
      if (d <= radiusKm) {
        results.push({ node: candidate, distanceKm: d });
      }
    }
    results.sort((a, b) => a.distanceKm - b.distanceKm);
    return results.map((r) => r.node);
  }

  /**
   * For a given demand node and a set of supply nodes, compute the
   * great-circle distance from each supply node to the demand node and
   * flag whether each is "feasible" (within the given tolerance).
   *
   * This is the spatial component of opportunity discovery: the
   * opportunity engine uses the result to filter supply candidates before
   * applying the full feasibility check (kind compatibility, capacity,
   * time windows, detour tolerance).
   *
   * @param demandNodeId     The demand node ID.
   * @param supplyNodeIds    The supply node IDs to evaluate.
   * @param toleranceKm      Maximum distance for a supply to be considered
   *                         feasible. Defaults to
   *                         DEFAULT_OPPORTUNITY_TOLERANCE_KM (50 km).
   * @returns                Array of { supplyNodeId, distanceKm, feasible }
   *                         for each supply node, sorted by ascending
   *                         distance. Supplies whose nodes don't exist in
   *                         the graph are SKIPPED (not included in the
   *                         result).
   */
  findOpportunityEdges(
    demandNodeId: string,
    supplyNodeIds: string[],
    toleranceKm: number = DEFAULT_OPPORTUNITY_TOLERANCE_KM,
  ): { supplyNodeId: string; distanceKm: number; feasible: boolean }[] {
    const demandNode = this.nodes.get(demandNodeId);
    if (!demandNode) return [];

    const results: {
      supplyNodeId: string;
      distanceKm: number;
      feasible: boolean;
    }[] = [];

    for (const supplyNodeId of supplyNodeIds) {
      const supplyNode = this.nodes.get(supplyNodeId);
      if (!supplyNode) continue; // skip unknown supply nodes
      const distanceKm = haversineKm(demandNode.point, supplyNode.point);
      results.push({
        supplyNodeId,
        distanceKm: Math.round(distanceKm * 1000) / 1000,
        feasible: distanceKm <= toleranceKm,
      });
    }

    results.sort((a, b) => a.distanceKm - b.distanceKm);
    return results;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

/** Clamp a number to [0, 1]. */
function clampUnit(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Compute aggregate metrics for a path (a list of edges). Returns total
 * distance (km), total travel time (sec), and the set of modes (edge
 * types) used. Useful for ranking paths returned by findRoutes().
 */
export function pathMetrics(path: GraphEdge[]): {
  totalDistanceKm: number;
  totalTravelTimeSec: number;
  modes: EdgeType[];
  transferCount: number;
} {
  let totalDistanceKm = 0;
  let totalTravelTimeSec = 0;
  const modes: EdgeType[] = [];
  let transferCount = 0;
  let prevType: EdgeType | null = null;

  for (const edge of path) {
    totalDistanceKm += edge.distanceKm;
    totalTravelTimeSec += edge.travelTimeSec;
    if (!modes.includes(edge.type)) modes.push(edge.type);
    if (edge.type === "transfer") transferCount += 1;
    if (prevType !== null && prevType !== edge.type && edge.type !== "transfer") {
      // A mode switch that isn't a transfer edge still counts as a transfer
      // (the traveler / shipment changed vehicles).
      transferCount += 1;
    }
    prevType = edge.type;
  }

  return {
    totalDistanceKm: Math.round(totalDistanceKm * 1000) / 1000,
    totalTravelTimeSec,
    modes,
    transferCount,
  };
}

/**
 * Convenience: create a fully-initialized TransportGraph from a list of
 * nodes and edges. Nodes are added first, then edges (so that edges can
 * reference the nodes). Returns the populated graph.
 */
export function buildGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
): TransportGraph {
  const graph = new TransportGraph();
  for (const node of nodes) graph.addNode(node);
  for (const edge of edges) graph.addEdge(edge);
  return graph;
}
