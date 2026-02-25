-- Rollback chat tables schema
DROP TRIGGER IF EXISTS update_chat_conversation_timestamp ON chat_messages;
DROP FUNCTION IF EXISTS update_conversation_timestamp();
DROP INDEX IF EXISTS idx_chat_messages_conversation_id;
DROP INDEX IF EXISTS idx_chat_conversations_stock_code;
DROP INDEX IF EXISTS idx_chat_conversations_user_id;
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS chat_conversations;
