# 内置浏览器权限契约

现有 `applyEmbeddedBrowserPermissionPolicy` 是 Electron partition 的装配入口。初始化等待站点权限记录加载，再注册 request/check/device handler；每个 partition 只装配一次。

站点权限管理器持有持久授权，当前 policy 实例持有会话授权和待决请求。request 与 check 都按标准 URL origin 查询；路径和尾斜杠不改变站点，协议或主机不同则隔离。未授权敏感权限交给注入的 prompt，未知权限拒绝。

```text
Electron request/check → 标准 origin → 同一授权记录 → 允许 / 拒绝 / 用户决策
```

设备选项与持久化通过已有 desktop 模块完成。本模块不改变权限清理、主窗口路由或跨进程协议。回归见 `packages/desktop/test/embeddedBrowserPermissionPolicy.test.ts` 和 `packages/desktop/test/e2e/browser-permission-prompt.test.ts`。

权限策略、main/renderer 决策转发和持久站点选择继续归本组件；原 bridge 保留请求身份、取消与超时拒绝，store 保留原文件格式与序列写入。站点设置页仅经原 useBrowserSitePermissions hook 读取和提交，不能自行授予权限。新增根只是将既有实现纳入受管，不改授权、选择期限或持久 writer。
