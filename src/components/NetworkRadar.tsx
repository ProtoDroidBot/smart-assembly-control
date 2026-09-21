import { useMemo, useState } from "react";
import type { RadarAssembly, RadarStructureType } from "../energy/client.ts";
import type { LocalizedTypeName } from "../localization/type-names.ts";
import {
  filterRadarContacts,
  projectRadarContact,
  RADAR_STRUCTURE_LABELS,
} from "../energy/radar.ts";

const amount = (value: number) =>
  value.toLocaleString(undefined, { maximumFractionDigits: 1 });
const signedKm = (value: number) =>
  `${value >= 0 ? "+" : ""}${amount(value / 1000)}`;
const state = (assembly: RadarAssembly) =>
  assembly.assemblyStatus === 2
    ? "online"
    : assembly.assemblyStatus === 1
      ? "offline"
      : "unknown";

export function NetworkRadar({
  contacts,
  radiusMeters,
  typeName,
}: {
  contacts: RadarAssembly[];
  radiusMeters: number;
  typeName: LocalizedTypeName;
}) {
  const [structureType, setStructureType] = useState<
    RadarStructureType | "all"
  >("all");
  const [linkedOnly, setLinkedOnly] = useState(false);
  const [producingOnly, setProducingOnly] = useState(false);
  const visible = useMemo(
    () =>
      filterRadarContacts(contacts, {
        structureType,
        linkedOnly,
        producingOnly,
      }),
    [contacts, structureType, linkedOnly, producingOnly],
  );
  const plotted = useMemo(
    () =>
      [...visible].sort(
        (left, right) =>
          projectRadarContact(left, radiusMeters).depth -
            projectRadarContact(right, radiusMeters).depth ||
          right.distanceMeters - left.distanceMeters,
      ),
    [visible, radiusMeters],
  );
  const types = (
    [
      ...new Set(contacts.map((contact) => contact.structureType)),
    ] as RadarStructureType[]
  ).sort((left, right) =>
    RADAR_STRUCTURE_LABELS[left].localeCompare(RADAR_STRUCTURE_LABELS[right]),
  );
  const linkedCount = contacts.filter((contact) => contact.linkedToNode).length;
  const producingCount = contacts.filter((contact) => contact.industry).length;

  return (
    <section
      className="network-radar"
      aria-label="Network Node three-dimensional assembly radar"
    >
      <div className="radar-heading">
        <div>
          <div className="section-kicker">3D ASSEMBLY RADAR</div>
          <h3>
            {contacts.length} {contacts.length === 1 ? "contact" : "contacts"}{" "}
            in range
          </h3>
        </div>
        <div className="radar-counters" aria-label="Radar contact summary">
          <span>
            <b>{linkedCount}</b> linked
          </span>
          <span className={producingCount ? "producing" : ""}>
            <b>{producingCount}</b> producing
          </span>
        </div>
      </div>
      <p>
        Completed Smart Assemblies within {amount(radiusMeters / 1000)} km.
        Position is relative to this node on the X, Y, and Z axes.
      </p>
      <div className="radar-filters">
        <label>
          Structure type
          <select
            value={structureType}
            onChange={(event) =>
              setStructureType(event.target.value as RadarStructureType | "all")
            }
          >
            <option value="all">All structures ({contacts.length})</option>
            {types.map((type) => (
              <option key={type} value={type}>
                {RADAR_STRUCTURE_LABELS[type]} (
                {
                  contacts.filter((contact) => contact.structureType === type)
                    .length
                }
                )
              </option>
            ))}
          </select>
        </label>
        <label className="radar-check">
          <input
            type="checkbox"
            checked={linkedOnly}
            onChange={(event) => setLinkedOnly(event.target.checked)}
          />{" "}
          Linked to this node
        </label>
        <label className="radar-check">
          <input
            type="checkbox"
            checked={producingOnly}
            onChange={(event) => setProducingOnly(event.target.checked)}
          />{" "}
          Actively producing
        </label>
      </div>
      <div className="radar-layout">
        <div className="radar-screen">
          <svg
            viewBox="0 0 100 100"
            role="img"
            aria-label={`${visible.length} filtered assemblies plotted in three-dimensional space`}
          >
            <defs>
              <radialGradient id="radar-field" cx="50%" cy="50%" r="55%">
                <stop offset="0" stopColor="currentColor" stopOpacity=".12" />
                <stop offset="1" stopColor="currentColor" stopOpacity="0" />
              </radialGradient>
            </defs>
            <rect width="100" height="100" fill="url(#radar-field)" />
            {[14, 28, 42].map((radius) => (
              <ellipse
                key={radius}
                className="radar-ring"
                cx="50"
                cy="50"
                rx={radius}
                ry={radius * 0.48}
              />
            ))}
            <path className="radar-axis" d="M8 50h84M50 8v84M16 78 84 22" />
            <text className="radar-axis-label" x="93" y="48">
              +X
            </text>
            <text className="radar-axis-label" x="51" y="8">
              +Y
            </text>
            <text className="radar-axis-label" x="83" y="20">
              -Z
            </text>
            {plotted.map((contact) => {
              const point = projectRadarContact(contact, radiusMeters);
              const floor = projectRadarContact(
                { relativePosition: { ...contact.relativePosition, y: 0 } },
                radiusMeters,
              );
              const production = contact.industry?.products
                .map(
                  (product) =>
                    `${typeName(product.typeID, product.name)} ×${product.quantityPerRun}`,
                )
                .join(", ");
              return (
                <g
                  key={contact.itemID}
                  className={`radar-contact ${contact.structureType}${contact.linkedToNode ? " linked" : ""}${contact.industry ? " producing" : ""}`}
                >
                  {Math.abs(point.y - floor.y) > 1 && (
                    <path
                      className="radar-stem"
                      d={`M${floor.x} ${floor.y}L${point.x} ${point.y}`}
                    />
                  )}
                  {contact.linkedToNode && (
                    <circle
                      className="radar-link"
                      cx={point.x}
                      cy={point.y}
                      r="3.1"
                    />
                  )}
                  {contact.industry && (
                    <circle
                      className="radar-pulse"
                      cx={point.x}
                      cy={point.y}
                      r="3.8"
                    />
                  )}
                  <circle
                    className="radar-blip"
                    cx={point.x}
                    cy={point.y}
                    r="1.8"
                  >
                    <title>{`${contact.name}; ${RADAR_STRUCTURE_LABELS[contact.structureType]}; ${amount(contact.distanceMeters / 1000)} km${contact.linkedToNode ? "; linked" : ""}${contact.industry ? `; producing ${production || "items"}` : ""}`}</title>
                  </circle>
                  <text className="radar-id" x={point.x + 2.5} y={point.y - 2}>
                    {contact.itemID}
                  </text>
                </g>
              );
            })}
            <g className="radar-node">
              <circle cx="50" cy="50" r="2.4" />
              <path d="M46 50h8M50 46v8" />
            </g>
          </svg>
          <div className="radar-legend">
            <span>
              <i className="linked" /> Linked
            </span>
            <span>
              <i className="producing" /> Producing
            </span>
            <span>
              <i /> Detected
            </span>
          </div>
        </div>
        <div className="inventory-scroll radar-results">
          <table className="inventory-table radar-table">
            <caption>
              {visible.length} of {contacts.length} contacts shown
            </caption>
            <thead>
              <tr>
                <th>Structure</th>
                <th>3D position</th>
                <th>Network</th>
                <th>Industry</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((contact) => (
                <tr key={contact.itemID}>
                  <td>
                    <b>{contact.name || `Assembly ${contact.itemID}`}</b>
                    <small>
                      {RADAR_STRUCTURE_LABELS[contact.structureType]} ·{" "}
                      {typeName(contact.typeID, contact.typeName)} · #
                      {contact.itemID}
                    </small>
                    <span className={`state ${state(contact)}`}>
                      {state(contact).toUpperCase()}
                    </span>
                  </td>
                  <td>
                    {amount(contact.distanceMeters / 1000)} km
                    <small>
                      X {signedKm(contact.relativePosition.x)} · Y{" "}
                      {signedKm(contact.relativePosition.y)} · Z{" "}
                      {signedKm(contact.relativePosition.z)} km
                    </small>
                  </td>
                  <td>
                    {contact.linkedToNode ? (
                      <span className="radar-positive">LINKED</span>
                    ) : (
                      "Detected"
                    )}
                  </td>
                  <td>
                    {contact.industry ? (
                      <>
                        <span className="radar-positive">
                          {contact.industry.state === "RUNNING"
                            ? "PRODUCING"
                            : "FINISHING RUN"}
                        </span>
                        <small>
                          Job #{contact.industry.jobID}
                          {contact.industry.products.length
                            ? ` · ${contact.industry.products.map((product) => `${typeName(product.typeID, product.name)} ×${product.quantityPerRun}`).join(", ")}`
                            : ""}
                        </small>
                      </>
                    ) : contact.structureType === "industry" ? (
                      "Idle"
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visible.length && (
            <p className="storage-empty">
              No radar contacts match these filters.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
