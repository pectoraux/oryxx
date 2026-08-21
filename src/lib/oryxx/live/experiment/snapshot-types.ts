// ORYXX — Live Observation Snapshot Types

export interface SnapshotStation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  free_bikes: number;
  empty_slots: number;
  timestamp: string;
}

export interface LiveObservationSnapshot {
  snapshotType: "LIVE_OBSERVATION_SNAPSHOT";
  source: string;
  networkName: string;
  networkId: string;
  location: {
    city: string;
    country: string;
    latitude: number;
    longitude: number;
  };
  capturedAt: string;
  stationCount: number;
  stations: SnapshotStation[];
}
