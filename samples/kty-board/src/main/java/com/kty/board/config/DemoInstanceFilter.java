package com.kty.board.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.context.annotation.Profile;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
@Profile("demo")
@Order(Ordered.HIGHEST_PRECEDENCE)
public class DemoInstanceFilter extends OncePerRequestFilter {
    private final String instance = System.getenv().getOrDefault("HOSTNAME", "local");
    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        response.setHeader("X-Instance-Id", instance);
        chain.doFilter(request, response);
    }
}
