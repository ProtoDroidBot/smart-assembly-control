import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { SuiClientTypes } from "@mysten/sui/client";

/** Read every page, rejecting a broken cursor instead of silently truncating state. */
export async function listDynamicFields(
  reader: Pick<SuiGrpcClient, "listDynamicFields">,
  parentId: string,
): Promise<SuiClientTypes.DynamicFieldEntry[]> {
  const fields: SuiClientTypes.DynamicFieldEntry[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await reader.listDynamicFields({ parentId, cursor, limit: 100 });
    fields.push(...page.dynamicFields);
    if (!page.hasNextPage) return fields;
    if (!page.cursor || cursors.has(page.cursor))
      throw new Error("Sui returned an invalid dynamic-field pagination cursor.");
    cursors.add(page.cursor);
    cursor = page.cursor;
  } while (true);
}
