# source-server-management-view

原 Source 管理只读投影与 UI。管理服务拥有事实；hook 保留 generation 和订阅撤销，名称 registry 按原服务对象保留唯一 WeakMap，不产生第二连接或迁移 writer。视图只提交原管理回调。

本轮只登记原实现与公开能力，不修改状态转换、数据格式、SQL、授权或已有观测。正式入口保持原函数，例子和合同测试消费同一公开能力；现有专项回归与最终组合验证另行执行。
