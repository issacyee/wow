/**
 * Deterministic JSON Schema normalization for provider tool payloads.
 *
 * Prefix cache rule: tool schema bytes must be stable across turns. Keep this
 * module conservative: sort object keys and order-insensitive keyword arrays,
 * but do not reorder semantic composition arrays such as oneOf / anyOf / allOf.
 */

const SORTABLE_STRING_ARRAY_KEYS = new Set([
  "required",
  "enum",
  "dependentRequired",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sortPrimitiveArray(value: unknown[]): unknown[] {
  if (!value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
    return value.map((item) => canonicalizeJson(item));
  }

  return [...value].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function canonicalizeJson(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    if (parentKey && SORTABLE_STRING_ARRAY_KEYS.has(parentKey)) {
      return sortPrimitiveArray(value);
    }
    return value.map((item) => canonicalizeJson(item));
  }

  if (!isPlainObject(value)) return value;

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (parentKey === "dependentRequired" && Array.isArray(child)) {
      out[key] = sortPrimitiveArray(child);
    } else {
      out[key] = canonicalizeJson(child, key);
    }
  }
  return out;
}

export function canonicalizeSchema<T>(schema: T): T {
  return canonicalizeJson(schema) as T;
}

function getToolName(tool: any): string {
  return tool?.function?.name ?? tool?.name ?? "";
}

function canonicalizeTool(tool: any): any {
  if (!tool || typeof tool !== "object") return tool;

  // OpenAI-compatible tool shape: { type: "function", function: { ... } }
  if (tool.function && typeof tool.function === "object") {
    return canonicalizeJson({
      ...tool,
      function: {
        ...tool.function,
        parameters: canonicalizeSchema(tool.function.parameters),
      },
    });
  }

  // Anthropic-like or other direct tool shape: { name, input_schema, ... }
  if (tool.input_schema) {
    return canonicalizeJson({
      ...tool,
      input_schema: canonicalizeSchema(tool.input_schema),
    });
  }

  if (tool.parameters) {
    return canonicalizeJson({
      ...tool,
      parameters: canonicalizeSchema(tool.parameters),
    });
  }

  return canonicalizeJson(tool);
}

export function canonicalizeTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools;

  return [...tools]
    .map((tool) => canonicalizeTool(tool))
    .sort((a, b) => getToolName(a).localeCompare(getToolName(b)));
}
