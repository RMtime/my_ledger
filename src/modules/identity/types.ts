export const permissions = ["metadata:read", "transactions:read", "transactions:create", "analytics:read"] as const;
export type Permission = typeof permissions[number];
export type ActorContext = {
  ownerId: string;
  actorType: "user" | "agent";
  actorId: string;
  permissions: Permission[];
  requestId: string;
};

export function userActor(ownerId: string, requestId = crypto.randomUUID()): ActorContext {
  return { ownerId, actorType: "user", actorId: ownerId, permissions: [...permissions], requestId };
}
