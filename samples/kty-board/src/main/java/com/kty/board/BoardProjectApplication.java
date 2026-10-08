package com.kty.board;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class BoardProjectApplication {

	public static void main(String[] args) {
		var context = SpringApplication.run(BoardProjectApplication.class, args);
		if (context.getEnvironment().matchesProfiles("schema-init")) context.close();
	}

}
