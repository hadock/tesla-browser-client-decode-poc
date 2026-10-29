/* Runtime config. Local-dev default; ./deploy.sh writes the real one into the build.
 * logsEnabled comes from ENABLE_LOGS at deploy time (default off). */
window.POC_CONFIG = {
  logsEnabled: false,
  logsUrl: "/api/logs",
  webCodecsTimeoutMs: 10000,
  logTarget: "local",
  logGroup: ""
};
