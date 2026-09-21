import type { AssemblyConfig } from "./types.ts";

export const assemblyRoutes = {
  overview: "/client/root/",
  behaviour: "/client/behaviour/",
  storage: "/client/storage/",
  industry: "/client/industry/",
  gate: "/client/gate/",
  network: "/client/networknode/monitor/",
  scanning: "/client/networknode/scanning/",
  scanResults: "/client/networknode/scanning/results/",
} as const;

export type AssemblyView = keyof typeof assemblyRoutes;

export function assemblyView(pathname: string): AssemblyView {
  const path = pathname.replace(/\/+$/, "");
  if (path === "/client/behaviour") return "behaviour";
  if (path === "/client/storage") return "storage";
  if (path === "/client/industry") return "industry";
  if (path === "/client/gate") return "gate";
  if (path === "/client/networknode/monitor") return "network";
  if (path === "/client/networknode/scanning") return "scanning";
  if (path === "/client/networknode/scanning/results") return "scanResults";
  return "overview";
}

export function assemblyInput(config: AssemblyConfig, params: URLSearchParams) {
  return (
    params.get("objectId") ||
    params.get("object_id") ||
    params.get("itemId") ||
    params.get("item_id") ||
    config.defaultObjectId ||
    config.defaultItemId ||
    ""
  );
}

/** Keep client context while replacing the assembly selection and its aliases. */
export function assemblySelection(
  search: string,
  input: string,
  tenant: string,
): URLSearchParams {
  const params = new URLSearchParams(search);
  for (const key of ["objectId", "object_id", "itemId", "item_id"])
    params.delete(key);
  params.set("tenant", tenant);
  params.set(/^0x/i.test(input.trim()) ? "objectId" : "itemId", input.trim());
  return params;
}

export function assemblyViewUrl(view: AssemblyView, search: string) {
  return `${assemblyRoutes[view]}${search && !search.startsWith("?") ? "?" : ""}${search}`;
}
