/* Runtime config. Local-dev default; ./deploy.sh writes the real one into the build. */
window.POC_CONFIG = {
  logsUrl: "/api/logs",
  webCodecsTimeoutMs: 10000,
  logTarget: "local",
  logGroup: ""
};
