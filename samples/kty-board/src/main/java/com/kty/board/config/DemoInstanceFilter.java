package com.kty.board.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.security.SecureRandom;
import java.util.HexFormat;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
@Profile("demo")
@Order(Ordered.HIGHEST_PRECEDENCE)
public class DemoInstanceFilter extends OncePerRequestFilter {
    private static final Logger log = LoggerFactory.getLogger(DemoInstanceFilter.class);
    private final String instance = instanceId(System.getenv("HOSTNAME"));

    public DemoInstanceFilter() {
        // 무작위 ID는 플랫폼 인스턴스 이름과 바로 이어지지 않는다. 이 한 줄로 플랫폼 로그(docker logs, CloudWatch, Cloud Logging)와 짝을 맞춘다.
        log.info("X-Instance-Id for this server: {}", instance);
    }

    /**
     * HOSTNAME이 있으면(Docker 컨테이너 ID, Fargate) 그대로 쓴다. 없으면(Cloud Run) 프로세스마다 무작위 ID를 만든다.
     * 예전처럼 "local"로 채우면 Cloud Run 2대가 같은 값을 내서 어느 서버가 답했는지 구별할 수 없었다.
     * 무작위 값은 IP·메타데이터·자격 증명을 쓰지 않으므로 응답 헤더로 내부 정보가 새지 않는다.
     */
    static String instanceId(String hostname) {
        if (hostname != null && !hostname.isBlank()) return hostname;
        return "i-" + HexFormat.of().toHexDigits(new SecureRandom().nextInt());
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        response.setHeader("X-Instance-Id", instance);
        chain.doFilter(request, response);
    }
}
