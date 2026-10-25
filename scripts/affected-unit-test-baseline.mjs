export function selectDefaultBranchRef({ originHead, hasCommit }) {
  // 组织主分支已统一为 main；旧 staging 引用不能抢占已确认的 main 基线。
  return ["origin/main", originHead, "origin/staging", "origin/master", "main", "master"].find(
    (candidate) => candidate && hasCommit(candidate),
  );
}
