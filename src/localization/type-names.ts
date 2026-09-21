import { useCallback, useEffect, useState } from "react";

export type TypeID = string | number;
export type LocalizedTypeName = (
  typeID: TypeID,
  suppliedName?: string | null,
) => string;

const TYPE_ID_MAX = 0xffff_ffffn;
const TYPE_API_BY_TENANT: Record<string, string> = {
  stillness: "https://world-api-stillness.live.pub.evefrontier.com",
  utopia: "https://world-api-utopia.uat.pub.evefrontier.com",
};

function normalizedTypeID(value: TypeID): string | null {
  const id = String(value).trim();
  if (!/^[1-9]\d*$/.test(id)) return null;
  const numeric = BigInt(id);
  return numeric <= TYPE_ID_MAX ? id : null;
}

function normalizedTenant(value?: string): string {
  const tenant = value?.trim().toLowerCase() || "stillness";
  return tenant === "utopia" || tenant.includes("utopia")
    ? "utopia"
    : "stillness";
}

export function typeCatalogBase(tenant?: string): string {
  return TYPE_API_BY_TENANT[normalizedTenant(tenant)];
}

export function fallbackTypeName(typeID: TypeID): string {
  return `Type ${String(typeID).trim()}`;
}

/** True for numeric server/UI fallbacks, not for an actual human-readable name. */
export function isPlaceholderTypeName(
  value: string | null | undefined,
  typeID: TypeID,
): boolean {
  const name = value?.trim();
  if (!name) return true;
  const id = String(typeID)
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^(?:type(?:\\s*id)?|item(?:\\s+type)?|fuel\\s+type)\\s*#?\\s*${id}$`,
    "i",
  ).test(name);
}

export function displayTypeName(
  typeID: TypeID,
  suppliedName?: string | null,
  localizedName?: string | null,
): string {
  if (!isPlaceholderTypeName(suppliedName, typeID)) return suppliedName!.trim();
  if (!isPlaceholderTypeName(localizedName, typeID))
    return localizedName!.trim();
  return fallbackTypeName(typeID);
}

export interface TypeNameCatalog {
  lookup(typeID: TypeID, tenant?: string): Promise<string | undefined>;
  peek(typeID: TypeID, tenant?: string): string | undefined;
}

export function createTypeNameCatalog(
  fetcher: typeof fetch = fetch,
  timeoutMs = 8000,
): TypeNameCatalog {
  const cache = new Map<string, Promise<string | undefined>>();
  const resolved = new Map<string, string | undefined>();
  const keyFor = (id: string, tenant?: string) =>
    `${normalizedTenant(tenant)}:${id}`;

  async function request(id: string, tenant?: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(
        `${typeCatalogBase(tenant)}/v2/types/${id}`,
        {
          cache: "force-cache",
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        },
      );
      if (!response.ok) return undefined;
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return undefined;
      const record = payload as Record<string, unknown>;
      if (String(record.id) !== id || typeof record.name !== "string")
        return undefined;
      const name = record.name.trim();
      return isPlaceholderTypeName(name, id) ? undefined : name;
    } catch {
      // Type metadata only enriches the UI. The dApp remains usable offline.
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    lookup(typeID, tenant) {
      const id = normalizedTypeID(typeID);
      if (!id) return Promise.resolve(undefined);
      const key = keyFor(id, tenant);
      let pending = cache.get(key);
      if (!pending) {
        pending = request(id, tenant).then((name) => {
          resolved.set(key, name);
          return name;
        });
        cache.set(key, pending);
      }
      return pending;
    },
    peek(typeID, tenant) {
      const id = normalizedTypeID(typeID);
      return id ? resolved.get(keyFor(id, tenant)) : undefined;
    },
  };
}

const defaultCatalog = createTypeNameCatalog();

/** Resolve all visible type IDs once and re-render when their names arrive. */
export function useLocalizedTypeNames(
  typeIDs: Iterable<TypeID | null | undefined>,
  tenant?: string,
): LocalizedTypeName {
  const ids = [
    ...new Set(
      [...typeIDs]
        .map((id) =>
          id === null || id === undefined ? null : normalizedTypeID(id),
        )
        .filter((id): id is string => !!id),
    ),
  ].sort();
  const key = ids.join(",");
  const [, setRevision] = useState(0);

  useEffect(() => {
    let current = true;
    const requestedIDs = key ? key.split(",") : [];
    void Promise.all(
      requestedIDs.map((id) => defaultCatalog.lookup(id, tenant)),
    ).then(() => {
      if (current) setRevision((value) => value + 1);
    });
    return () => {
      current = false;
    };
  }, [key, tenant]);

  return useCallback(
    (typeID, suppliedName) =>
      displayTypeName(
        typeID,
        suppliedName,
        defaultCatalog.peek(typeID, tenant),
      ),
    [tenant],
  );
}
