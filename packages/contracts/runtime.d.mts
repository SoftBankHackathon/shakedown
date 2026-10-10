export type HttpRuntime = {
  version: 'http-runtime.v1'; port: number; health_path: string;
  env: Record<string,string>; secret_refs: Record<string,string>;
  database: {mode:'none'|'postgres'|'mysql'|'mongodb'|'external';name:string;bindings:Record<string,'host'|'port'|'name'|'username'|'password'|'jdbc_url'|'postgres_url'|'mysql_url'|'mongodb_url'>};
  init_command: string[];
};
export function validateRuntime(value: unknown): HttpRuntime;
export function databaseEnvironment(r: HttpRuntime, db:{host:string;username:string;ssl:boolean}): Record<string,string>;

export function postgresUrl(db:{host:string;username:string;password:string;name:string;ssl:boolean}): string;

export function managedDatabase(mode:string):boolean;
export function databasePort(mode:string):number;
export function databaseUrl(settings:{mode:string;host:string;username:string;password:string;name:string;ssl:boolean}):string;
