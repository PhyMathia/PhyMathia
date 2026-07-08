import { pgTable, serial, timestamp, index, varchar, bigint, foreignKey, integer, text } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const healthCheck = pgTable("health_check", {
	id: serial().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

export const sessions = pgTable("sessions", {
	id: varchar({ length: 128 }).primaryKey().notNull(),
	title: varchar({ length: 256 }).default('新对话').notNull(),
	icon: varchar({ length: 64 }).default(').notNull(),
	cozeSessionId: varchar("coze_session_id", { length: 256 }).default(').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => [
	index("sessions_updated_at_idx").using("btree", table.updatedAt.asc().nullsLast().op("int8_ops")),
]);

export const messages = pgTable("messages", {
	id: serial().primaryKey().notNull(),
	sessionId: varchar("session_id", { length: 128 }).notNull(),
	msgIndex: integer("msg_index").notNull(),
	msgData: text("msg_data").notNull(),
}, (table) => [
	index("messages_session_id_idx").using("btree", table.sessionId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.sessionId],
			foreignColumns: [sessions.id],
			name: "messages_session_id_fkey"
		}),
]);

export const knowledgeItems = pgTable("knowledge_items", {
	id: varchar({ length: 128 }).primaryKey().notNull(),
	sessionId: varchar("session_id", { length: 128 }).notNull(),
	itemData: text("item_data").notNull(),
}, (table) => [
	index("knowledge_items_session_id_idx").using("btree", table.sessionId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.sessionId],
			foreignColumns: [sessions.id],
			name: "knowledge_items_session_id_fkey"
		}),
]);

export const kvStore = pgTable("kv_store", {
	key: varchar({ length: 256 }).primaryKey().notNull(),
	value: text().notNull(),
});
