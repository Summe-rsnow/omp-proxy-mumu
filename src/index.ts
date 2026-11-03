import type { ExtensionContext, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { loadConfig } from "./config.js";
import { ProxyInterceptor } from "./interceptor.js";
import { registerProxyCommand } from "./command.js";

const STATUS_KEY = "proxy";

const extension: ExtensionFactory = (pi) => {
  const initialConfig = loadConfig();
  const interceptor = new ProxyInterceptor(initialConfig);

  let currentUi: ExtensionContext["ui"] | undefined;

  const updateStatusBar = (ui?: ExtensionContext["ui"]) => {
    const targetUi = ui || currentUi;
    if (!targetUi) return;

    if (interceptor.isProxyActive()) {
      const dot = targetUi.theme?.fg ? targetUi.theme.fg("success", "●") : "●";
      const label = targetUi.theme?.fg ? targetUi.theme.fg("accent", "PROXY ON") : "PROXY ON";
      targetUi.setStatus(STATUS_KEY, `${dot} ${label}`);
    } else {
      targetUi.setStatus(STATUS_KEY, undefined);
    }
  };

  // Keep status bar synchronized whenever proxy state transitions
  interceptor.onStatusChange(() => {
    updateStatusBar();
  });

  // Install fetch & network hooks
  interceptor.install();

  // Register /proxy slash command
  registerProxyCommand(pi, interceptor);

  // Hook session lifecycle
  let hasCheckedThisSession = false;

  pi.on("session_start", async (_event, ctx) => {
    currentUi = ctx.ui;

    if (hasCheckedThisSession) {
      updateStatusBar(currentUi);
      return;
    }
    hasCheckedThisSession = true;

    // Apply config and run non-blocking initial probe if enabled
    const cfg = interceptor.getConfig();
    if (cfg.enabled) {
      await interceptor.updateConfigAndApply(cfg, (msg, level) => {
        ctx.ui?.notify(msg, level);
      });
    }

    updateStatusBar(currentUi);
  });

  pi.on("session_shutdown", () => {
    if (currentUi) {
      currentUi.setStatus(STATUS_KEY, undefined);
      currentUi = undefined;
    }
    interceptor.uninstall();
  });
};

export default extension;
