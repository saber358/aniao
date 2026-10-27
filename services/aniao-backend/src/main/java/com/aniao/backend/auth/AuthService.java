package com.aniao.backend.auth;

import com.aniao.backend.common.ApiException;
import com.aniao.backend.user.AppUser;
import com.aniao.backend.user.Role;
import com.aniao.backend.user.UserRepository;
import com.aniao.backend.user.UserStatus;
import com.aniao.backend.user.UserView;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Locale;

@Service
public class AuthService {
	private final UserRepository users;
	private final PasswordEncoder encoder;
	private final JwtService jwt;

	public AuthService(UserRepository users, PasswordEncoder encoder, JwtService jwt) {
		this.users = users;
		this.encoder = encoder;
		this.jwt = jwt;
	}

	@Transactional
	public AuthResponse register(RegisterRequest request) {
		String username = request.username().trim().toLowerCase(Locale.ROOT);
		if (users.existsByUsername(username)) {
			throw new ApiException(HttpStatus.CONFLICT, "username_taken", "用户名已被占用");
		}
		AppUser user = new AppUser(
				username,
				encoder.encode(request.password()),
				request.displayName() == null || request.displayName().isBlank()
						? username
						: request.displayName().trim(),
				Role.USER);
		users.save(user);
		return issue(user);
	}

	@Transactional
	public AuthResponse login(LoginRequest request) {
		String username = request.username().trim().toLowerCase(Locale.ROOT);
		AppUser user = users.findByUsername(username)
				.orElseThrow(() -> new ApiException(HttpStatus.UNAUTHORIZED, "invalid_credentials", "用户名或密码错误"));
		if (!encoder.matches(request.password(), user.getPasswordHash())) {
			throw new ApiException(HttpStatus.UNAUTHORIZED, "invalid_credentials", "用户名或密码错误");
		}
		if (user.getStatus() != UserStatus.ACTIVE) {
			throw new ApiException(HttpStatus.FORBIDDEN, "account_disabled", "账号已被禁用");
		}
		user.setLastLoginAt(Instant.now());
		users.save(user);
		return issue(user);
	}

	@Transactional
	public void changePassword(AppUser user, ChangePasswordRequest request) {
		if (!encoder.matches(request.currentPassword(), user.getPasswordHash())) {
			throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_password", "当前密码不正确");
		}
		user.setPasswordHash(encoder.encode(request.newPassword()));
		users.save(user);
	}

	private AuthResponse issue(AppUser user) {
		JwtService.Token token = jwt.issue(user.getId(), user.getUsername(), user.getRole().name());
		return new AuthResponse(token.value(), token.expiresAt(), UserView.from(user));
	}

	public record RegisterRequest(
			@jakarta.validation.constraints.NotBlank
			@jakarta.validation.constraints.Pattern(regexp = "^[A-Za-z0-9_.-]{3,32}$", message = "用户名需为 3-32 位字母、数字、点、下划线或连字符")
			String username,
			@jakarta.validation.constraints.NotBlank
			@jakarta.validation.constraints.Size(min = 8, max = 72, message = "密码长度需为 8-72 位")
			String password,
			@jakarta.validation.constraints.Size(max = 100)
			String displayName) {
	}

	public record LoginRequest(
			@jakarta.validation.constraints.NotBlank String username,
			@jakarta.validation.constraints.NotBlank String password) {
	}

	public record ChangePasswordRequest(
			@jakarta.validation.constraints.NotBlank String currentPassword,
			@jakarta.validation.constraints.NotBlank
			@jakarta.validation.constraints.Size(min = 8, max = 72, message = "新密码长度需为 8-72 位")
			String newPassword) {
	}

	public record AuthResponse(String token, Instant expiresAt, UserView user) {
	}
}
