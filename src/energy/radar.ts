import type { RadarAssembly, RadarStructureType } from "./client.ts";

export const RADAR_STRUCTURE_LABELS: Record<RadarStructureType, string> = {
  assembly: "Smart Assembly",
  industry: "Smart Industry",
  storage_unit: "Smart Storage Unit",
  gate: "Smart Gate",
  turret: "Smart Turret",
  network_node: "Network Node",
};

export interface RadarFilter {
  structureType: RadarStructureType | "all";
  linkedOnly: boolean;
  producingOnly: boolean;
}

export function filterRadarContacts(
  contacts: readonly RadarAssembly[],
  filter: RadarFilter,
) {
  return contacts.filter(
    (contact) =>
      (filter.structureType === "all" ||
        contact.structureType === filter.structureType) &&
      (!filter.linkedOnly || contact.linkedToNode) &&
      (!filter.producingOnly || contact.industry !== null),
  );
}

/** Isometric projection of a relative 3D position into the radar's 100x100 view box. */
export function projectRadarContact(
  contact: Pick<RadarAssembly, "relativePosition">,
  radiusMeters: number,
) {
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0)
    throw new Error("Radar radius must be positive.");
  const { x, y, z } = contact.relativePosition;
  if (![x, y, z].every(Number.isFinite))
    throw new Error("Radar contact position must be finite.");
  const nx = x / radiusMeters;
  const ny = y / radiusMeters;
  const nz = z / radiusMeters;
  return {
    x: 50 + nx * 34 + nz * 14,
    y: 50 - ny * 30 + nz * 12,
    depth: nz,
  };
}
