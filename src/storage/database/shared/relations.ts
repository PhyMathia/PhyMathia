import { relations } from "drizzle-orm/relations";
import { sessions, messages, knowledgeItems } from "./schema";

export const messagesRelations = relations(messages, ({one}) => ({
	session: one(sessions, {
		fields: [messages.sessionId],
		references: [sessions.id]
	}),
}));

export const sessionsRelations = relations(sessions, ({many}) => ({
	messages: many(messages),
	knowledgeItems: many(knowledgeItems),
}));

export const knowledgeItemsRelations = relations(knowledgeItems, ({one}) => ({
	session: one(sessions, {
		fields: [knowledgeItems.sessionId],
		references: [sessions.id]
	}),
}));