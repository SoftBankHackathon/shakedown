# ---- 이미지·로그·클러스터 ----
# CFN DeletionPolicy: Retain과 맞춘다. 이미지가 남아 있으면 destroy가 멈춘다(force_delete=false).
resource "aws_ecr_repository" "this" {
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/shakedown/${var.name}"
  retention_in_days = 7
  # CFN Retain: destroy해도 로그는 남긴다.
  skip_destroy = true
}

resource "aws_ecs_cluster" "this" {
  name = var.name
}

# ---- ALB와 트래픽 게이트 ----
resource "aws_lb" "this" {
  name               = var.name
  internal           = false
  load_balancer_type = "application"
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]
  # 인터넷 경로가 생긴 뒤에 만든다 (CFN DependsOn: PublicRoute).
  depends_on = [aws_route.internet, aws_route_table_association.public]
}

resource "aws_lb_target_group" "this" {
  # 포트를 바꾸면 교체되므로 고정 이름 대신 접두어(6자 이하)를 쓴다.
  name_prefix          = "sdtg-"
  port                 = var.app_port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.this.id
  deregistration_delay = "5"
  # 어댑터가 배포마다 같은 값으로 다시 쓰는 속성은 똑같이 선언해 드리프트가 나지 않게 한다 (aws-provider.ts:113-115).
  load_balancing_algorithm_type = "round_robin"
  stickiness {
    type    = "lb_cookie"
    enabled = false
  }
  health_check {
    path                = "/"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
    matcher             = "200"
  }
  lifecycle {
    create_before_destroy = true
    # 어댑터가 요청의 health_path로 바꾼다 (aws-provider.ts:112).
    ignore_changes = [health_check[0].path]
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }
}

# 처음에는 모든 요청을 403으로 막는다. 어댑터가 준비 확인 뒤 forward로, 차단 때 다시 403으로 바꾼다.
resource "aws_lb_listener_rule" "gate" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 1
  condition {
    source_ip {
      values = ["0.0.0.0/0", "::/0"]
    }
  }
  action {
    type = "fixed-response"
    fixed_response {
      status_code  = "403"
      content_type = "text/plain"
      message_body = "Shakedown: deployment unavailable"
    }
  }
  lifecycle {
    # 어댑터(aws-provider.ts:48-51)와 infra/https가 forward·403·redirect를 오간다. apply가 되돌리면 차단이 풀리거나 서비스가 막힌다.
    ignore_changes = [action]
  }
}
