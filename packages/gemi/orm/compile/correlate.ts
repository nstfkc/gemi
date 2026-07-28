import type { SqlDialect } from "../dialect";
import { MalformedRelationError } from "../errors";
import type { ModelSchema, RelationSchema } from "../schema";
import { relatedSchema, resolveLink } from "./plan-relations";

/**
 * The three pieces every correlated subquery over a relation needs, for both
 * kinds of relation.
 *
 * Three call sites now build one: `exists` for a relation filter, `count(*)` for
 * `_count`, and a scalar for an `orderBy`. Each had its own copy of "resolve the
 * link, quote the two key columns, write the correlation" — and each refused
 * implicit many-to-many separately, with its own message, because the m-n shape
 * needs a *second* table in the subquery and none of them had anywhere to put
 * it.
 *
 * That is what this exists for. The join table is a difference in the subquery's
 * `from` clause and nowhere else, so hoisting the `from` and the correlation out
 * of the three callers makes m-n a property of one function rather than a
 * capability each caller has to grow.
 *
 * Direct foreign key:
 *
 *     from "Account" as "_r0"                      where "_r0"."userId" = "User"."id"
 *
 * Implicit many-to-many:
 *
 *     from "Tag" as "_r0"
 *       join "_PostToTag" as "_r0j" on "_r0j"."B" = "_r0"."id"
 *                                                  where "_r0j"."A" = "Post"."id"
 *
 * The child is aliased in both cases, even when nothing is ambiguous — a
 * self-relation puts the same table on both sides and the subquery's own `from`
 * would shadow the outer one, so the correlation would compare a row to itself.
 * Aliasing conditionally would put the dangerous case on the rarely-taken branch.
 */

export interface Correlated {
  /** The related model's schema, resolved through the registry. */
  child: ModelSchema;
  /** Everything after `from `, including the join table when there is one. */
  source: string;
  /** The predicate tying the subquery to the outer row. */
  correlation: string;
  /** Prefix for the child's own columns — `"_r0".`. */
  qualifier: string;
}

export function correlate(
  parent: ModelSchema,
  relation: RelationSchema,
  dialect: SqlDialect,
  /** Distinct per nesting level or per term; the caller owns uniqueness. */
  alias: string,
  /** How the outer row is named: the parent's table, or an enclosing alias. */
  parentQualifier: string,
  /** The caller's operation, so a refused link names where it came from. */
  operation = "include",
): Correlated {
  const child = relatedSchema(parent, relation);
  // Throws for a self-referential implicit m-n, where the artifact cannot say
  // which join column is which end. That refusal is the planner's and predates
  // this; it is reached here rather than duplicated.
  const link = resolveLink(parent, child, relation, operation);

  const quoted = dialect.quoteIdent(alias);
  const qualifier = `${quoted}.`;
  const childKey = `${qualifier}${dialect.quoteIdent(column(child, relation, link.childField))}`;
  const parentKey = `${parentQualifier}${dialect.quoteIdent(column(parent, relation, link.parentField))}`;

  if (!link.join) {
    return {
      child,
      source: `${dialect.quoteIdent(child.table)} as ${quoted}`,
      correlation: `${childKey} = ${parentKey}`,
      qualifier,
    };
  }

  // The join table gets the child's alias with a `j`, so two nested m-n filters
  // cannot collide any more than their children can.
  const joinAlias = dialect.quoteIdent(`${alias}j`);

  return {
    child,
    source:
      `${dialect.quoteIdent(child.table)} as ${quoted} ` +
      `join ${dialect.quoteIdent(link.join.table)} as ${joinAlias} ` +
      `on ${joinAlias}.${dialect.quoteIdent(link.join.childColumn)} = ${childKey}`,
    correlation: `${joinAlias}.${dialect.quoteIdent(link.join.parentColumn)} = ${parentKey}`,
    qualifier,
  };
}

function column(
  schema: ModelSchema,
  relation: RelationSchema,
  name: string,
): string {
  const field = schema.fields[name];
  if (!field) {
    throw new MalformedRelationError(
      schema.name,
      relation.name,
      `it joins on '${name}', which is not a field on ${schema.name}.`,
    );
  }
  return field.column;
}
