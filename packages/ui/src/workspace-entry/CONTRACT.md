# workspace-entry

Root.workspaceEntry renders the same native App and responsive sidebar without an attached workspace, path or session. The trusted caller supplies display content, pending UI state and an explicit preparation callback. No writable native call is made by rendering this state. Draft options are renderer-only and retain their original lease. Existing account, application-page, settings and focus owners remain in place. No new execution queue or persistence is introduced. See docs/design/deferred-workspace-entry.md.

应用可通过 `ApplicationPeripherals.prepareIndependentTask` 选择已连接位置的原生普通会话工作区。全局新建及无项目入口进入该工作区；显式项目与远端目标仍由项目服务准备。首页交付的草稿意图必须在定位对应目录后初始化。
