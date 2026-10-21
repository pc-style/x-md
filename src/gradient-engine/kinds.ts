import type { GradientKindDefinition } from "./kind";
import { chrome } from "./shaders/chrome";
import { limb } from "./shaders/limb";
import { mesh } from "./shaders/mesh";
import { spectrum } from "./shaders/spectrum";
import type { GradientKind, GradientParams } from "./types";

export type { GradientKindDefinition } from "./kind";

const registry = new Map<string, GradientKindDefinition>();

/** Adds a kind. Re-registering a name replaces it. */
export function registerKind(definition: GradientKindDefinition): void {
  registry.set(definition.name, definition);
}

for (const definition of [
  mesh,
  limb,
  spectrum,
  chrome,
]) {
  registerKind(definition);
}

/** The kind's definition, or mesh when the name is unknown. */
export function getKind(kind: GradientKind): GradientKindDefinition {
  return registry.get(kind) ?? mesh;
}

export function listKinds(): GradientKindDefinition[] {
  return [...registry.values()];
}

/** Full params tuned for a kind. */
export function kindDefaults(kind: GradientKind): GradientParams {
  const definition = getKind(kind);
  return { ...definition.defaults, kind: definition.name };
}
