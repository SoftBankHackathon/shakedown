export type HttpRuntime = {
  version: 'http-runtime.v1'; port: number; health_path: string;
  env: Record<string,string>; secret_refs: Record<string,string>;
  database: {mode:'none'|'postgres'|'external';name:string;bindings:Record<string,'host'|'port'|'name'|'username'|'password'|'jdbc_url'>};
  init_command: string[];
};
export function validateRuntime(value: unknown): HttpRuntime;
export function databaseEnvironment(r: HttpRuntime, db:{host:string;username:string;ssl:boolean}): Record<string,string>;
