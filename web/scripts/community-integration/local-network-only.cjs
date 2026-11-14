// Only the integration harness loads this preload. Application Node processes
// may talk to the disposable services, never to a production/default origin.
const net = require("node:net");
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.createConnection can pass its already-normalized argument array.
  const [options] = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
  const host = options.host || "localhost";
  if (!options.path && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(
      `Community integration blocked non-loopback connection: ${host}`,
    );
  }
  return originalConnect.apply(this, args);
};
