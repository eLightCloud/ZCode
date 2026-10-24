# Model protocol and invocation boundary

model 身份、消息、请求、状态、用量与 schema 使用既有唯一数据定义。公开入口仍为 package 的 model index；内部实现从实际定义取型，不反向导入该聚合入口。

- 默认 domain 层仅包含纯模型结构、校验与用量运算，不选择 Provider 或发起网络请求。
- invocation-context 是 adapters 层的既有 AsyncLocalStorage carrier；状态仍只保存在这一份异步上下文。index 与 contract / example / test 是该边界的公开装配及验证。
- carrier 不裁决权限，不存 Token；自动化父链的 modelRequestPurpose 限制不能被子链清除，迭代流恢复同一 context。
- Provider IO、凭据获取和重试接纳继续由原执行 / 适配 owner 负责。失败仍抛原错误；不新增回退或环境变量。
- 验证空模型身份拒绝、异步流的限制继承和释放，以及全部原有模型合同用例。
