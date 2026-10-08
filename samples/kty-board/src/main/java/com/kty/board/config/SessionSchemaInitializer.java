package com.kty.board.config;

import javax.sql.DataSource;
import org.springframework.boot.CommandLineRunner;
import org.springframework.context.annotation.Profile;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.stereotype.Component;

/** Run once as a job, before either application instance starts. */
@Component
@Profile("schema-init")
public class SessionSchemaInitializer implements CommandLineRunner {
    private final DataSource dataSource;
    public SessionSchemaInitializer(DataSource dataSource) { this.dataSource = dataSource; }
    @Override
    public void run(String... args) throws Exception {
        try (var connection = dataSource.getConnection()) {
            var metadata = connection.getMetaData();
            boolean sessionExists;
            boolean attributesExist;
            try (var tables = metadata.getTables(connection.getCatalog(), null, (metadata.storesLowerCaseIdentifiers() ? "spring_session" : "SPRING_SESSION"), new String[]{"TABLE"})) {
                sessionExists = tables.next();
            }
            try (var tables = metadata.getTables(connection.getCatalog(), null, (metadata.storesLowerCaseIdentifiers() ? "spring_session_attributes" : "SPRING_SESSION_ATTRIBUTES"), new String[]{"TABLE"})) {
                attributesExist = tables.next();
            }
            if (sessionExists != attributesExist) throw new IllegalStateException("Partial session schema: inspect before retrying");
            if (sessionExists) return;
            String vendor = switch (metadata.getDatabaseProductName()) {
                case "H2" -> "h2";
                case "PostgreSQL" -> "postgresql";
                default -> throw new IllegalStateException("Unsupported session database: " + metadata.getDatabaseProductName());
            };
            var resource = new ClassPathResource("org/springframework/session/jdbc/schema-" + vendor + ".sql");
            new ResourceDatabasePopulator(resource).execute(dataSource);
        }
    }
}
