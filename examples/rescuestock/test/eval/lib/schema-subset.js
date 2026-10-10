// A local stand-in for "the provider accepts this schema" (F-TR-13): the structured-output subset documented at
// https://platform.claude.com/docs/en/build-with-claude/structured-outputs (fetched 2026-10-09). It is used by the
// loopback Anthropic stub (HTTP 400 when violated) and by the fake-mode eval. It proves nothing about the real API;
// only the first live run does (case cli-image-smoke, and the first API call).
const UNSUPPORTED = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'patternProperties', 'not', 'if', 'then', 'else'];

export function schemaSubsetProblems(schema) {
  const problems = [];
  // `isMap` marks the `properties` and `$defs` objects, whose keys are names, not schema keywords.
  const walk = (node, path, isMap = false) => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (isMap) {
      for (const [name, child] of Object.entries(node)) walk(child, `${path}.${name}`);
      return;
    }
    if (node.type === 'object' && node.properties && node.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
    if (node.type === 'object' && node.properties) {
      const props = Object.keys(node.properties).sort().join(',');
      const req = [...(node.required ?? [])].sort().join(',');
      if (props !== req) problems.push(`${path}: every property must be required`);
    }
    for (const [key, value] of Object.entries(node)) {
      if (UNSUPPORTED.includes(key)) problems.push(`${path}.${key}: unsupported keyword`);
      walk(value, `${path}.${key}`, key === 'properties' || key === '$defs');
    }
  };
  walk(schema, '$');
  return problems;
}
