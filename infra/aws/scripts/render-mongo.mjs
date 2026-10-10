// Keep generated EC2 UserData identical to the reviewed bootstrap source.
import fs from 'node:fs';
import YAML from 'yaml';
const file=new URL('../cloudformation/foundation.yaml',import.meta.url);
const f=YAML.parse(fs.readFileSync(file,'utf8'));
const source=fs.readFileSync(new URL('./mongodb-node.sh',import.meta.url),'utf8');
const r=f.Resources;
f.Parameters.EnableMongoSnapshots={Type:'String',Default:'true',AllowedValues:['true','false']};
f.Conditions.WithMongoSnapshots={'Fn::And':[{Condition:'WithMongo'},{'Fn::Equals':[{Ref:'EnableMongoSnapshots'},'true']}]};
for(let i=0;i<3;i++) {
 const suffix=i===0?'':String(i+1), instance='MongoInstance'+suffix,volume='MongoData'+suffix,attachment='MongoAttachment'+suffix;
 if(i>0){r[volume]=structuredClone(r.MongoData);r[instance]=structuredClone(r.MongoInstance);r[attachment]=structuredClone(r.MongoAttachment);}
 r[volume].Properties.AvailabilityZone={'Fn::GetAtt':[['PublicA','PublicB','PublicC'][i],'AvailabilityZone']};
 r[volume].Properties.Tags=[{Key:'Name',Value:{'Fn::Sub':'${Name}-mongo-data-'+i}}];
 r[instance].DependsOn=['PublicRoute',['RouteA','RouteB','RouteC'][i]];
 r[instance].Properties.NetworkInterfaces[0].SubnetId={Ref:['PublicA','PublicB','PublicC'][i]};
 r[instance].Properties.NetworkInterfaces[0].PrivateIpAddress=`10.42.${i}.50`;
 r[instance].Properties.Tags=[{Key:'Name',Value:{'Fn::Sub':'${Name}-mongo-'+i}}];
 r[instance].Properties.UserData={'Fn::Base64':{'Fn::Sub':source.replaceAll('@@INDEX@@',String(i)).replaceAll('@@VOLUME@@','${'+volume+'}')}};
 r[attachment].Properties.InstanceId={Ref:instance};r[attachment].Properties.VolumeId={Ref:volume};
}
r.MongoReady.DependsOn=['MongoAttachment','MongoAttachment2','MongoAttachment3'];
r.MongoReady.Properties.Timeout='1800';
r.MongoClusterSecret={Condition:'WithMongo',Type:'AWS::SecretsManager::Secret',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{Description:'Mongo TLS leaf/keyfile/admin bootstrap bundle; EC2 role only',SecretString:'{}'}};
r.MongoCaSecret={Condition:'WithMongo',Type:'AWS::SecretsManager::Secret',DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:{Description:'Public Mongo CA certificate for app trust',SecretString:'{}'}};
r.MongoRole.Properties.Policies[0].PolicyDocument.Statement=[{Effect:'Allow',Action:'secretsmanager:GetSecretValue',Resource:[{Ref:'DbSecret'},{Ref:'MongoClusterSecret'}]},{Effect:'Allow',Action:'secretsmanager:PutSecretValue',Resource:[{Ref:'DbUrlSecret'},{Ref:'MongoClusterSecret'},{Ref:'MongoCaSecret'}]}];
r.MongoPeerIngress={Condition:'WithMongo',Type:'AWS::EC2::SecurityGroupIngress',Properties:{GroupId:{Ref:'MongoSg'},IpProtocol:'tcp',FromPort:27017,ToPort:27017,SourceSecurityGroupId:{Ref:'MongoSg'}}};
for(const statements of [r.ExecutionRole.Properties.Policies[0].PolicyDocument.Statement,r.AdapterPolicy.Properties.PolicyDocument.Statement]){
 if(!statements.some(s=>s['Fn::If']?.[0]==='WithMongo'))statements.push({'Fn::If':['WithMongo',{Effect:'Allow',Action:'secretsmanager:GetSecretValue',Resource:{Ref:'MongoCaSecret'}},{Ref:'AWS::NoValue'}]});
}
for(const key of ['MongoBackupVault','MongoBackupRole','MongoBackupPlan','MongoBackupSelection'])delete r[key];
for(const key of ['MongoData','MongoData2','MongoData3'])r[key].Properties.Tags.push({Key:'ShakedownMongoBackup',Value:{Ref:'Name'}});
r.MongoSnapshotRole={Condition:'WithMongoSnapshots',Type:'AWS::IAM::Role',Properties:{AssumeRolePolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'dlm.amazonaws.com'},Action:'sts:AssumeRole'}]},ManagedPolicyArns:[{'Fn::Sub':'arn:${AWS::Partition}:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole'}]}};
r.MongoSnapshotPolicy={Condition:'WithMongoSnapshots',Type:'AWS::DLM::LifecyclePolicy',Properties:{Description:'Daily Mongo EBS crash-consistent snapshots retain seven',State:'ENABLED',ExecutionRoleArn:{'Fn::GetAtt':['MongoSnapshotRole','Arn']},PolicyDetails:{ResourceTypes:['VOLUME'],TargetTags:[{Key:'ShakedownMongoBackup',Value:{Ref:'Name'}}],Schedules:[{Name:'daily',CreateRule:{Interval:24,IntervalUnit:'HOURS',Times:['18:00']},RetainRule:{Count:7},CopyTags:true}]}}};
f.Outputs.DbHosts={Condition:'WithMongo',Value:'10.42.0.50,10.42.1.50,10.42.2.50'};
f.Outputs.DbInstanceIds={Condition:'WithMongo',Value:{'Fn::Join':[',',[{Ref:'MongoInstance'},{Ref:'MongoInstance2'},{Ref:'MongoInstance3'}]]}};
f.Outputs.DbCaSecretArn={Condition:'WithMongo',Value:{Ref:'MongoCaSecret'}};
f.Description='Shakedown ECS with RDS PostgreSQL/MySQL or TLS MongoDB replica set across three AZs';
fs.writeFileSync(file,YAML.stringify(f,{lineWidth:0}).replaceAll('- 18:00',"- '18:00'"));
