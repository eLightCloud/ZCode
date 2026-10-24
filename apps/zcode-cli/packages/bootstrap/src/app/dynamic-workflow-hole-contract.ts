// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
/**
 * 一处留白的编译期事实：站点 id、字面名、类型实参原文、调用所在的脚本行，以及此刻开放与否。
 * 从站点表抄下来而不是持有站点表本身：`SiteTable` 挂着整棵 AST，注册表条目要活到 run 结算。
 */
export interface CompiledHole {
  siteId: string;
  name: string;
  type: string;
  /** `hole(...)` 调用在脚本里的行号（1 起）。 */
  line: number;
  /** 没有函数体 = 开放的留白；补全后变成 false，嵌套在体内的新留白随之出现在表里。 */
  open: boolean;
}
