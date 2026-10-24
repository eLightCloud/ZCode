export const CONVERSATION_BARRIER_SQL=`
CREATE TABLE conversation_index_barriers(
 workspace_key TEXT NOT NULL, task_id TEXT NOT NULL, operation TEXT NOT NULL,
 PRIMARY KEY(workspace_key,task_id)
);
CREATE TRIGGER conversation_index_actions_fenced BEFORE UPDATE ON tasks
WHEN EXISTS(SELECT 1 FROM conversation_index_barriers b
 WHERE b.workspace_key=OLD.workspace_key AND b.task_id=OLD.task_id)
AND (NEW.pinned<>OLD.pinned OR NEW.archived<>OLD.archived OR NEW.deleted<>OLD.deleted
 OR NEW.title_overridden<>OLD.title_overridden
 OR ((OLD.title_overridden=1 OR NEW.title_overridden=1) AND NEW.title<>OLD.title))
BEGIN SELECT RAISE(ABORT,'conversation_index_admission_closed'); END;
`;
