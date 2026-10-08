import https from 'node:https';
import dns from 'node:dns';
import { Resolver } from 'node:dns/promises';

// Quick Tunnel DNS can be published after the local resolver caches NXDOMAIN.
// Fallback applies only to generated trycloudflare.com hosts; TLS still verifies
// the original hostname/SNI. No OS DNS setting or certificate bypass is used.
export function publicHealth(url, timeout = 5000) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(target.hostname)) return Promise.resolve(false);
  return new Promise(resolve => {
    const lookup = (hostname, options, callback) => {
      dns.lookup(hostname, options, (error, address, family) => {
        if (!error) return callback(null, address, family);
        const resolver = new Resolver({timeout:1500,tries:1});
        resolver.setServers(['1.1.1.1','1.0.0.1']);
        resolver.resolve4(hostname).then(addresses => {
          if (options.all) callback(null,addresses.map(address=>({address,family:4})));
          else callback(null,addresses[0],4);
        }).catch(()=>callback(error));
      });
    };
    const request = https.get(target, {lookup}, response => { response.resume(); resolve(response.statusCode === 200); });
    const timer = setTimeout(()=>request.destroy(new Error('Health check timeout')),timeout);
    request.on('error',()=>resolve(false));
    request.on('close',()=>clearTimeout(timer));
  });
}
