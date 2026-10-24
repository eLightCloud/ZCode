# source-server-workspace-contract

原生公开错误码与工作区服务描述的既有合同；没有运行状态、SQLite writer 或部署权限。services 继续通过原 descriptor 发布工作区调用，Shared 不导入服务实现。

本轮只登记原实现与公开能力，不修改状态转换、数据格式、SQL、授权或已有观测。正式入口保持原函数，例子和合同测试消费同一公开能力；现有专项回归与最终组合验证另行执行。
