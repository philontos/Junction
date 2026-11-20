import os from 'node:os';
import { Agent, Dispatcher, buildConnector, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

/** An explicit per-node setting, never an automatic VPN bypass. Resolve the
 * interface on each connection so DHCP changes do not pin a stale address. */
export function cloudSocketOptions(outboundInterface = '') {
  if (!outboundInterface) return {};
  const address = os.networkInterfaces()[outboundInterface]?.find(item => item.family === 'IPv4')?.address;
  if (!address) throw Object.assign(new Error('Configured cloud network interface is unavailable'), { code: 'EADDRNOTAVAIL' });
  return { localAddress: address, family: 4 };
}

/** Scope fetch routing to this node's configured Junction origin. Local APIs,
 * provider APIs and every other destination retain their existing dispatcher.
 * TLS verification is unchanged. */
export function configureCloudNetwork(cloudOrigin: string, outboundInterface: string) {
  const origin = new URL(cloudOrigin).origin, previous = getGlobalDispatcher();
  const connect = buildConnector({ timeout: 10000 });
  const cloud = new Agent({ connect(options, callback) {
    try { return connect({ ...options, localAddress: cloudSocketOptions(outboundInterface).localAddress }, callback); }
    catch (error) { callback(error as Error, null); }
  } });
  const routed = new class extends Dispatcher {
    dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) {
      return (String(options.origin) === origin ? cloud : previous).dispatch(options, handler);
    }
  }();
  setGlobalDispatcher(routed);
  return async () => {
    if (getGlobalDispatcher() === routed) setGlobalDispatcher(previous);
    await cloud.close();
  };
}

export function configureCloudNetworkFromEnv() {
  const origin = process.env.SWITCHYARD_CLOUD_NETWORK_ORIGIN;
  const network = process.env.SWITCHYARD_CLOUD_NETWORK_INTERFACE;
  if (origin && network) configureCloudNetwork(origin, network);
}
