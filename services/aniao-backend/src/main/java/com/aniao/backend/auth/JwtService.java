package com.aniao.backend.auth;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;

@Service
public class JwtService {
	private final SecretKey key;
	private final Duration ttl;

	public JwtService(
			@Value("${app.jwt.secret}") String secret,
			@Value("${app.jwt.ttl-days:7}") long ttlDays) {
		if (secret == null || secret.getBytes(StandardCharsets.UTF_8).length < 32) {
			throw new IllegalStateException("ANIAO_JWT_SECRET must be at least 32 bytes");
		}
		this.key = Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
		this.ttl = Duration.ofDays(Math.max(1, ttlDays));
	}

	public Token issue(long userId, String username, String role) {
		Instant now = Instant.now();
		Instant expiresAt = now.plus(ttl);
		String value = Jwts.builder()
				.subject(Long.toString(userId))
				.claim("username", username)
				.claim("role", role)
				.issuedAt(Date.from(now))
				.expiration(Date.from(expiresAt))
				.signWith(key)
				.compact();
		return new Token(value, expiresAt);
	}

	public Claims parse(String token) {
		try {
			return Jwts.parser().verifyWith(key).build().parseSignedClaims(token).getPayload();
		} catch (JwtException | IllegalArgumentException exception) {
			return null;
		}
	}

	public record Token(String value, Instant expiresAt) {
	}
}
