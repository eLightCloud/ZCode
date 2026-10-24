# workflow-run-presentation

工作流状态的既有纯显示模型，只读取 SessionWorkflowActivity，不调度、不写 run 状态、不改变确认集合。保留活跃/结束分类、最多两行及 overflow。

本轮只登记原实现与公开能力，不修改状态转换、数据格式、SQL、授权或已有观测。正式入口保持原函数，例子和合同测试消费同一公开能力；现有专项回归与最终组合验证另行执行。
