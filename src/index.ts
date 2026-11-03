import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { loadConfig } from "./config.js";
import { ProxyInterceptor } from "./interceptor.js";
import { registerProxyCommand } from "./command.js";

const extension: ExtensionFactory = (pi) => {
  const initialConfig = loadConfig();
  const interceptor = new ProxyInterceptor(initialConfig);

  // Install fetch & network hooks
  interceptor.install();

  // Register /proxy slash command
  registerProxyCommand(pi, interceptor);

  // Hook session lifecycle
  let hasCheckedThisSession = false;

  pi.on("session_start", async (_event, ctx) => {
    if (hasCheckedThisSession) return;
    hasCheckedThisSession = true;

    // Apply config and run non-blocking initial probe if enabled
    const cfg = interceptor.getConfig();
    if (cfg.enabled) {
      await interceptor.updateConfigAndApply(cfg, (msg, level) => {
        ctx.ui?.notify(msg, level);
      });
    }
  });

  pi.on("session_shutdown", () => {
    interceptor.uninstall();
  });
};

export default extension;
