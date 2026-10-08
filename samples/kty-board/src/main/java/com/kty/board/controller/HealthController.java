package com.kty.board.controller;

import javax.sql.DataSource;
import java.sql.Connection;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {
    private final DataSource dataSource;
    public HealthController(DataSource dataSource) { this.dataSource = dataSource; }

    @GetMapping("/health")
    public ResponseEntity<Map<String, Boolean>> health() {
        try (Connection connection = dataSource.getConnection()) {
            boolean ok = connection.isValid(2);
            return ResponseEntity.status(ok ? 200 : 503).body(Map.of("ok", ok));
        } catch (Exception e) {
            return ResponseEntity.status(503).body(Map.of("ok", false));
        }
    }
}
