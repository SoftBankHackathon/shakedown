import fs from 'node:fs';
import YAML from 'yaml';
const template=JSON.stringify(YAML.parse(fs.readFileSync(new URL('../cloudformation/foundation.yaml',import.meta.url),'utf8')));
if(Buffer.byteLength(template)>51200)throw Error('Template exceeds inline CloudFormation size limit');
fs.writeFileSync(process.argv[2],template,{mode:0o600});
