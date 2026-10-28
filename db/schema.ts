import { sqliteTable, text, integer, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const records = sqliteTable('aegis_records', {
  namespace: text('namespace').notNull(),
  id: text('id').notNull(),
  payload: text('payload').notNull(),
  updatedAt: text('updated_at').notNull(),
  revision: text('revision').notNull().default(''),
}, (table) => [primaryKey({ columns: [table.namespace, table.id] })]);

export const deployments = sqliteTable('aegis_deployments', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id').notNull(),
  alias: text('alias').notNull(),
  version: integer('version').notNull(),
  payload: text('payload').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [uniqueIndex('aegis_deployment_alias_version').on(table.alias, table.version)]);

export const gatewayKeys = sqliteTable('aegis_gateway_keys', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  hash: text('hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
  revoked: integer('revoked').notNull().default(0),
});

export const requestLogs = sqliteTable('aegis_request_logs', {
  id: text('id').primaryKey(),
  payload: text('payload').notNull(),
  createdAt: text('created_at').notNull(),
});
