/** Shared Git materialization arguments for marketplace and plugin sources. */
const FULL_COMMIT_ID = /^[a-f0-9]{40}$/iu;

export function planGitCheckout(input: {
  url: string;
  directory: string;
  ref?: string;
  sha?: string;
  sparsePaths?: string[];
}): { clone: string[]; afterClone: string[][] } {
  const identity = input.sha ?? input.ref;
  const commit = identity && FULL_COMMIT_ID.test(identity) ? identity.toLowerCase() : undefined;
  const clone = ["clone"];
  const afterClone: string[][] = [];
  // 完整提交号不是分支名：浅克隆后显式 fetch 该对象，再 detached checkout。
  // 不存在的提交直接失败，不能退回默认分支使企业审核版本失效。
  if (commit) {
    clone.push("--no-checkout", "--depth", "1");
    afterClone.push(
      ["-C", input.directory, "fetch", "--depth", "1", "origin", commit],
      ["-C", input.directory, "checkout", "--detach", "FETCH_HEAD"],
    );
  } else {
    if (!input.sha) clone.push("--depth", "1");
    if (input.ref) clone.push("--branch", input.ref);
    // 保留既有显式短 sha / commit 写法的完整克隆与 checkout 语义。
    if (input.sha) afterClone.push(["-C", input.directory, "checkout", input.sha]);
  }
  if (input.sparsePaths?.length) {
    clone.push("--filter=blob:none", "--sparse");
    afterClone.push(["-C", input.directory, "sparse-checkout", "set", ...input.sparsePaths]);
  }
  clone.push(input.url, input.directory);
  return { clone, afterClone };
}
