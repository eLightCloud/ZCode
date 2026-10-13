import { useEffect, useRef } from "react";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useAlertDialog } from "@/hooks/useAlertDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

/** Application admission does not supply native cloud credentials or entitlements. */
export function useApplicationAccountLoginEntry(applicationOwned: boolean): void {
  const request = useZCodeStore((state) => state.loginEntryRequest);
  const clear = useZCodeStore((state) => state.clearLoginEntryRequest);
  const mark = useZCodeStore((state) => state.markLoginEntryAttemptStatus);
  const alert = useAlertDialog();
  const { intl } = useZCodeIntl();
  const handled = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!applicationOwned || !request || handled.current === request.id) return;
    handled.current = request.id;
    // 供应商连接和云功能共用原生登录请求；不能静默丢弃或把企业主体当供应商账号。
    mark(request.id, "failed");
    clear(request.id);
    logger.info({
      event: "application.login.unavailable",
      outcome: "rejected",
      reason: "native_cloud_account_unavailable",
      correlation_id: String(request.id),
    });
    void alert({
      title: intl.formatMessage({ id: "application.account.cloudUnavailableTitle" }),
      description: intl.formatMessage({ id: "application.account.cloudUnavailableDescription" }),
      actionLabel: intl.formatMessage({ id: "common.confirm" }),
    });
  }, [applicationOwned, request, clear, mark, alert, intl]);
}
