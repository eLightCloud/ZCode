import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { LexicalChatInput, type LexicalChatInputHandle } from "@/LexicalChatInput.js";

// 使用真实 Lexical、键盘插件和编辑器 API；仅用可控回执替代网络，复现提交等待窗口。
const mode = new URLSearchParams(location.search).get("mode");
function Fixture() {
  const input = useRef<LexicalChatInputHandle | null>(null);
  const revision = useRef(0);
  const submittedRevision = useRef(0);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [count, setCount] = useState(0);
  const [text, setText] = useState("");
  const [sent, setSent] = useState("");
  const submit = (value: string) => {
    if (pendingRef.current) return false;
    submittedRevision.current = revision.current;
    pendingRef.current = true;
    setPending(true);
    setCount((current) => current + 1);
    setSent(value);
    return false;
  };
  const settle = (accepted: boolean) => {
    if (accepted && revision.current === submittedRevision.current) input.current?.clear();
    pendingRef.current = false;
    setPending(false);
  };
  return (
    <main>
      <LexicalChatInput
        workspacePath="/synthetic-repeat-send"
        taskId={null}
        inputTestId="editor"
        editorApiRef={input}
        enableMentionPanel={false}
        submitDisabled={pending}
        enterSubmits={mode !== "mobile"}
        onSubmit={submit}
        onModifiedSubmit={mode === "modified" ? submit : undefined}
        onChange={(value) => {
          revision.current += 1;
          setText(value);
        }}
      />
      <output data-testid="state">{JSON.stringify({ pending, count, text, sent })}</output>
      <button onClick={() => settle(true)}>Accept</button>
      <button onClick={() => settle(false)}>Reject</button>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
