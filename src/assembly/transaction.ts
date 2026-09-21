import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { requireObjectId, worldTypeOrigin } from "./config.ts";
import { ASSEMBLY_TYPES } from "./types.ts";
import type {
  AssemblyAction,
  AssemblyConfig,
  AssemblySnapshot,
} from "./types.ts";

export function validateAssemblyAction(
  config: AssemblyConfig,
  assembly: AssemblySnapshot,
  action: AssemblyAction,
  sender: string,
): void {
  requireObjectId(config.packageId, "World package ID");
  if (!Object.prototype.hasOwnProperty.call(ASSEMBLY_TYPES, assembly.kind))
    throw new Error("This assembly type is not supported.");
  if (action !== "online" && action !== "offline")
    throw new Error("Choose an online or offline action.");
  if (
    requireObjectId(sender, "Connected wallet address") !==
    requireObjectId(assembly.ownerAddress, "Owner wallet address")
  ) {
    throw new Error("Connect the wallet that owns this assembly's character.");
  }
  if (assembly.state !== "online" && assembly.state !== "offline")
    throw new Error("Refresh this assembly before changing an unknown state.");
  if (assembly.state === action)
    throw new Error(`This assembly is already ${action}.`);
  requireObjectId(assembly.id, "Assembly object ID");
  requireObjectId(assembly.characterId, "Owner character ID");
  if (
    requireObjectId(
      assembly.ownerCapRef.objectId,
      "Owner capability reference",
    ) !== requireObjectId(assembly.ownerCapId, "Owner capability ID")
  ) {
    throw new Error(
      "The owner capability reference has changed. Refresh the assembly.",
    );
  }
  if (assembly.kind !== "network_node") {
    requireObjectId(assembly.networkNodeId, "Connected network node ID");
    requireObjectId(config.energyConfigId, "Energy Config ID");
    if (action === "online" && assembly.networkNodeState !== "online")
      throw new Error(
        "Bring the connected network node online before this assembly.",
      );
  } else if (action === "offline") {
    requireObjectId(config.fuelConfigId, "Fuel Config ID");
    if (assembly.connectedAssemblies.length)
      requireObjectId(config.energyConfigId, "Energy Config ID");
    const ids = new Set<string>();
    for (const connected of assembly.connectedAssemblies) {
      if (
        !Object.prototype.hasOwnProperty.call(ASSEMBLY_TYPES, connected.kind) ||
        (connected.kind as string) === "network_node"
      )
        throw new Error("A connected assembly has an unsupported type.");
      const id = requireObjectId(connected.id, "Connected assembly ID");
      if (ids.has(id))
        throw new Error(
          "The network node's connection list contains duplicate IDs.",
        );
      ids.add(id);
      if (connected.state !== "online" && connected.state !== "offline")
        throw new Error(
          "Refresh the state of every connected assembly before shutting down the network node.",
        );
      if (
        requireObjectId(
          connected.networkNodeId,
          "Connected assembly energy source",
        ) !== requireObjectId(assembly.id, "Network node ID")
      )
        throw new Error(
          "A connected assembly belongs to a different network node. Refresh the chain state.",
        );
    }
  }
}

/** Builds only; the caller refreshes state and requests wallet approval before execution. */
export function buildAssemblyTransaction(
  config: AssemblyConfig,
  assembly: AssemblySnapshot,
  action: AssemblyAction,
  sender: string,
): Transaction {
  validateAssemblyAction(config, assembly, action, sender);
  const tx = new Transaction();
  tx.setSender(requireObjectId(sender, "Connected wallet address"));
  const worldPackage = requireObjectId(config.packageId, "World package ID");
  const type = `${worldTypeOrigin(config)}::${ASSEMBLY_TYPES[assembly.kind]}`;
  const [ownerCap, receipt] = tx.moveCall({
    target: `${worldPackage}::character::borrow_owner_cap`,
    typeArguments: [type],
    arguments: [
      tx.object(assembly.characterId),
      tx.receivingRef(assembly.ownerCapRef),
    ],
  });
  if (assembly.kind !== "network_node") {
    tx.moveCall({
      target: `${worldPackage}::${assembly.kind}::${action}`,
      arguments: [
        tx.object(assembly.id),
        tx.object(assembly.networkNodeId!),
        tx.object(config.energyConfigId),
        ownerCap,
      ],
    });
  } else if (action === "online") {
    tx.moveCall({
      target: `${worldPackage}::network_node::online`,
      arguments: [
        tx.object(assembly.id),
        ownerCap,
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
  } else {
    let [remaining] = tx.moveCall({
      target: `${worldPackage}::network_node::offline`,
      arguments: [
        tx.object(assembly.id),
        tx.object(config.fuelConfigId),
        ownerCap,
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
    for (const connected of assembly.connectedAssemblies) {
      [remaining] = tx.moveCall({
        target: `${worldPackage}::${connected.kind}::offline_connected_${connected.kind}`,
        arguments: [
          tx.object(connected.id),
          remaining,
          tx.object(assembly.id),
          tx.object(config.energyConfigId),
        ],
      });
    }
    // OfflineAssemblies has no drop ability: consume it even when there are no connections.
    tx.moveCall({
      target: `${worldPackage}::network_node::destroy_offline_assemblies`,
      arguments: [remaining],
    });
  }
  tx.moveCall({
    target: `${worldPackage}::character::return_owner_cap`,
    typeArguments: [type],
    arguments: [tx.object(assembly.characterId), ownerCap, receipt],
  });
  return tx;
}
