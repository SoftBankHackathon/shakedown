import {isIP} from 'node:net';
// Operator-only configuration; API callers cannot choose an endpoint or host port.
export function deliveryConfig(env = {}) {
 const mode=env.LOCAL_DELIVERY_MODE??'tunnel';
 if(!['tunnel','direct'].includes(mode))throw Error('LOCAL_DELIVERY_MODE must be tunnel or direct');
 if(mode==='tunnel')return {mode};
 let url;
 try {url=new URL(env.LOCAL_PUBLIC_URL);}catch{throw Error('Direct mode requires LOCAL_PUBLIC_URL');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('LOCAL_PUBLIC_URL must be an HTTP(S) origin without credentials/path/query/fragment');
 const bind=env.LOCAL_BIND_ADDRESS??'127.0.0.1',port=Number(env.LOCAL_APP_PORT??18080);
 if(isIP(bind)!==4||!Number.isInteger(port)||port<1024||port>65535||port===9101)throw Error('Invalid direct IPv4 bind or app port (1024-65535, excluding 9101)');
 return {mode,publicUrl:url.origin,bind,port};
}
export function applyDelivery(spec,request,config) {
 for(const service of Object.values(spec.services))service.restart='unless-stopped';
 if(config.mode==='direct'){
  delete spec.services.tunnel;
  spec.services.app.ports=[`${config.bind}:${config.port}:${request.runtime?.port??request.port}`];
 }
 return spec;
}
