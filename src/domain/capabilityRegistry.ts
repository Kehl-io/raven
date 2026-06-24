import type { CapabilityDescriptor } from "./types";

export function capabilityId(provider: string, action: string): string {
  return `${provider}.${action}`;
}

export function capabilityMap(
  capabilities: CapabilityDescriptor[],
): Map<string, CapabilityDescriptor> {
  return new Map(capabilities.map((capability) => [capability.id, capability]));
}
