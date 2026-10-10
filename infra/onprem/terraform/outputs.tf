# 엔진에 넣을 설정 (비밀값 없음). 서버 env와 같은 local.delivery_env에서 나온다.
resource "local_file" "engine_env" {
  filename        = var.engine_env_path
  content         = local.delivery_env
  file_permission = "0600"
}

output "public_url" {
  value = local.public_url
}

output "instance_id" {
  value = aws_instance.host.id
}

# 제어 API(9101)는 loopback 전용이다. 개발 PC의 엔진은 SSM 포트 포워딩으로 붙는다 (session-manager-plugin 필요).
output "port_forward_command" {
  value = "aws ssm start-session --profile ${var.profile} --region ${local.region} --target ${aws_instance.host.id} --document-name AWS-StartPortForwardingSession --parameters portNumber=9101,localPortNumber=9101"
}

