import { sql } from "drizzle-orm";
import { db } from "@/db/client";

export interface GraphContextArgs {
  userId: string;
  scope: { documentId?: string; folderId?: string };
  entities?: string[];
  themes?: string[];
  docIds: string[];
  maxHops?: number;
}

export interface GraphContextResult {
  entities: Array<{ name: string; type: string; description: string }>;
  relations: Array<{ source: string; target: string; relation: string; description: string }>;
}

function textArrayLiteral(items: string[]): string {
  const escaped = items.map((s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${escaped.join(",")}}`;
}

// ponytail: graph traversal — entry entities → 1-2 hop neighbors +
// their chunk_ids. Pure graph walk, no vectors (vectors already used by
// entityLeg/relationLeg to find the entry points). Audit §7.
//
// Algorithm: BFS from entryEntities, accumulating edges' source/target
// pair + chunk_ids. At hop=N we collect edges where either endpoint is
// in the current frontier; the other endpoint joins the next frontier.
// `neighborEntities` is the union of newly-discovered entity names;
// `chunkIds` is the union across all hops.
export interface ExpandFromEntitiesArgs {
  userId: string;
  scope: { documentId?: string; folderId?: string };
  entryEntities: string[];
  hops?: number;
}

export interface ExpandFromEntitiesResult {
  neighborEntities: string[];
  chunkIds: string[];
  edgeTexts: Array<{ source: string; target: string; relation: string }>;
}

const MAX_HOPS = 2;
const MAX_NEIGHBORS = 100;

export async function expandFromEntities(
  args: ExpandFromEntitiesArgs,
): Promise<ExpandFromEntitiesResult> {
  const hops = Math.max(1, Math.min(args.hops ?? 1, MAX_HOPS));
  const empty: ExpandFromEntitiesResult = {
    neighborEntities: [],
    chunkIds: [],
    edgeTexts: [],
  };
  if (args.entryEntities.length === 0) return empty;

  const docFilterClause = args.scope.documentId
    ? sql` AND document_id = ${args.scope.documentId}`
    : args.scope.folderId
      ? sql` AND document_id IN (SELECT id FROM kb_document WHERE folder_id = ${args.scope.folderId})`
      : sql``;

  const visited = new Set<string>();
  let frontier = Array.from(new Set(args.entryEntities.map((n) => n.trim()).filter(Boolean)));
  for (const n of frontier) visited.add(n.toLowerCase());

  const neighborEntities = new Set<string>();
  const chunkIds = new Set<string>();
  const edgeTexts: ExpandFromEntitiesResult["edgeTexts"] = [];

  for (let hop = 0; hop < hops; hop++) {
    if (frontier.length === 0) break;

    const rows = await db.execute<{
      source: string;
      target: string;
      relation: string;
      source_chunk_ids: string[];
    }>(sql`
      SELECT source, target, relation, source_chunk_ids
      FROM kb_relationship
      WHERE user_id = ${args.userId}
        AND (lower(source) = ANY(${textArrayLiteral(frontier.map((f) => f.toLowerCase()))}::text[])
             OR lower(target) = ANY(${textArrayLiteral(frontier.map((f) => f.toLowerCase()))}::text[]))
        ${docFilterClause}
      LIMIT ${MAX_NEIGHBORS}
    `);

    const nextFrontier = new Set<string>();
    for (const r of rows) {
      edgeTexts.push({ source: r.source, target: r.target, relation: r.relation });
      for (const cid of r.source_chunk_ids ?? []) chunkIds.add(cid);
      // The other endpoint becomes a neighbor; if not yet visited,
      // queue it for the next hop.
      for (const endpoint of [r.source, r.target]) {
        const key = endpoint.trim().toLowerCase();
        if (!key || visited.has(key)) continue;
        visited.add(key);
        neighborEntities.add(endpoint.trim());
        nextFrontier.add(endpoint.trim());
      }
    }
    frontier = Array.from(nextFrontier);
  }

  return {
    neighborEntities: Array.from(neighborEntities),
    chunkIds: Array.from(chunkIds),
    edgeTexts,
  };
}

export async function assembleGraphContext(
  args: GraphContextArgs,
): Promise<GraphContextResult | undefined> {
  const entityTerms = (args.entities ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const themeTerms = (args.themes ?? [])
    .flatMap((t) => t.trim().toLowerCase().split(/\s+/))
    .filter(Boolean);

  const qents = Array.from(new Set([...entityTerms, ...themeTerms]));
  if (qents.length === 0 && args.docIds.length === 0) {
    return undefined;
  }

  const docFilterClause = args.scope.documentId
    ? sql` AND document_id = ${args.scope.documentId}`
    : args.scope.folderId
      ? sql` AND document_id IN (SELECT id FROM kb_document WHERE folder_id = ${args.scope.folderId})`
      : args.docIds.length > 0
        ? sql` AND document_id = ANY(${textArrayLiteral(args.docIds)}::text[])`
        : sql``;

  const entityClause =
    qents.length > 0 ? sql` AND lower(name) = ANY(${textArrayLiteral(qents)}::text[])` : sql``;

  const entityRows = await db.execute<{
    name: string;
    type: string;
    description: string;
  }>(sql`
    SELECT DISTINCT name, type, description
    FROM kb_entity
    WHERE user_id = ${args.userId} ${docFilterClause} ${entityClause}
    LIMIT 20
  `);

  const relClause =
    qents.length > 0
      ? sql` AND (lower(source) = ANY(${textArrayLiteral(qents)}::text[]) OR lower(target) = ANY(${textArrayLiteral(qents)}::text[]))`
      : sql``;

  const relRows = await db.execute<{
    source: string;
    target: string;
    relation: string;
    description: string;
  }>(sql`
    SELECT DISTINCT source, target, relation, description
    FROM kb_relationship
    WHERE user_id = ${args.userId} ${docFilterClause} ${relClause}
    LIMIT 20
  `);

  if (entityRows.length === 0 && relRows.length === 0) {
    return undefined;
  }

  return {
    entities: entityRows.map((e) => ({
      name: e.name,
      type: e.type,
      description: e.description ?? "",
    })),
    relations: relRows.map((r) => ({
      source: r.source,
      target: r.target,
      relation: r.relation,
      description: r.description ?? "",
    })),
  };
}
