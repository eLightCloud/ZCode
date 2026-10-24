// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
/** 一个 run 的 actor 会话静默探询面。driver 私有能力，**不上** Boundary B 的 `WorkflowDriver`。 */
export interface ActorSessionQuiescence {
  /**
   * 此刻已经静默（不再有在写的 turn）的会话 id。有界等待，见 {@link AMEND_TRANSCRIPT_QUIESCE_MS}。
   *
   * 「不在集合里」有两种成因，调用方对两者同等处理（都不接续）：会话到点仍在写，或者这个
   * driver 压根不认识它——后者只会出现在「前驱这一世从没给该 actor 建过会话」的形状上，
   * 保守读成不静默即可（代价是少一次接续，而反过来是拿一个没人为其负责的条数去截断转录）。
   */
  quietSessions(): Promise<ReadonlySet<string>>;
}

/** driver 侧的写面：{@link ActorSessionQuiescence} 加一个 dispose 时的登记口。 */
export interface ActorSessionQuiescenceLedger extends ActorSessionQuiescence {
  /**
   * 登记一个会话与它**此刻**仍在飞的 turn 收尾链（`SessionState.turn`）。`pendingTurn` 缺席
   * 即该会话没有在飞 turn，立刻算静默。
   *
   * 由 `dispose()` 对它名下每个会话各调一次：那是唯一一个「还看得见全部会话、且已经没有新
   * turn 会被发起」的时刻（dispose 之后 `sessions` 就被清空了）。
   */
  noteDisposed(sessionId: string, pendingTurn: Promise<unknown> | undefined): void;
}
