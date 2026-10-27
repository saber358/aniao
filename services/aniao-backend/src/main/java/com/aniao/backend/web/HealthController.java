package com.aniao.backend.web;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class HealthController {
	@GetMapping("/health")
	Map<String, Object> health() {
		return Map.of(
				"status", "ok",
				"service", "aniao-backend",
				"version", "0.1.0",
				"time", Instant.now());
	}
}
