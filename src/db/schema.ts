import { customType, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const sqliteBigint = customType<{ data: bigint; driverData: bigint | number }>({
  dataType: () => "integer",
  fromDriver: (value) => BigInt(value),
  toDriver: (value) => value,
});

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
};

export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(), authSubject: text("auth_subject").notNull().unique(), email: text("email").notNull(),
  timezone: text("timezone").notNull().default("Asia/Hong_Kong"), baseCurrency: text("base_currency").notNull().default("HKD"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true), ...timestamps,
});

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), name: text("name").notNull(), type: text("type").notNull(),
  currency: text("currency").notNull(), archivedAt: text("archived_at"), ...timestamps,
}, (t) => [uniqueIndex("accounts_owner_name_uq").on(t.ownerId, t.name)]);

export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), name: text("name").notNull(), parentId: text("parent_id"),
  transactionKind: text("transaction_kind").notNull(), archivedAt: text("archived_at"), ...timestamps,
}, (t) => [uniqueIndex("categories_owner_name_kind_uq").on(t.ownerId, t.name, t.transactionKind)]);

export const channels = sqliteTable("channels", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), name: text("name").notNull(), archivedAt: text("archived_at"), ...timestamps,
}, (t) => [uniqueIndex("channels_owner_name_uq").on(t.ownerId, t.name)]);

export const transactions = sqliteTable("transactions", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), kind: text("kind").notNull(),
  amountMinor: sqliteBigint("amount_minor").notNull(), currency: text("currency").notNull(),
  occurredAt: text("occurred_at").notNull(), occurredTimezone: text("occurred_timezone").notNull(), timePrecision: text("time_precision").notNull(),
  categoryId: text("category_id"), paymentMethod: text("payment_method"), accountId: text("account_id"), channelId: text("channel_id"),
  merchant: text("merchant"), note: text("note"), relatedTransactionId: text("related_transaction_id"),
  transferGroupId: text("transfer_group_id"), transferDirection: text("transfer_direction"), source: text("source").notNull(), agentId: text("agent_id"),
  idempotencyKey: text("idempotency_key").notNull(), requestHash: text("request_hash").notNull(), version: integer("version").notNull().default(1),
  deletedAt: text("deleted_at"), ...timestamps,
}, (t) => [uniqueIndex("transactions_owner_idempotency_uq").on(t.ownerId, t.idempotencyKey)]);

export const transactionFx = sqliteTable("transaction_fx", {
  transactionId: text("transaction_id").primaryKey(), baseCurrency: text("base_currency").notNull(), rate: text("rate").notNull(),
  baseAmountMinor: sqliteBigint("base_amount_minor").notNull(), rateDate: text("rate_date").notNull(),
  rateSource: text("rate_source").notNull(), rateKind: text("rate_kind").notNull(),
});

export const agentCredentials = sqliteTable("agent_credentials", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), agentName: text("agent_name").notNull(), tokenPrefix: text("token_prefix").notNull(),
  tokenHash: text("token_hash").notNull().unique(), permissions: text("permissions").notNull(), expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"), lastUsedAt: text("last_used_at"), ...timestamps,
});

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), actorType: text("actor_type").notNull(), actorId: text("actor_id").notNull(),
  operation: text("operation").notNull(), transactionId: text("transaction_id"), beforeJson: text("before_json"), afterJson: text("after_json"),
  requestId: text("request_id").notNull(), createdAt: text("created_at").notNull(),
});

export const aiReports = sqliteTable("ai_reports", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), period: text("period").notNull(), filtersJson: text("filters_json").notNull(),
  snapshotJson: text("snapshot_json").notNull(), snapshotHash: text("snapshot_hash").notNull(), model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(), reportJson: text("report_json").notNull(), createdAt: text("created_at").notNull(),
});
