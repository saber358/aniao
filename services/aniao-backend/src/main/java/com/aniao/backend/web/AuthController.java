package com.aniao.backend.web;

import com.aniao.backend.auth.AuthService;
import com.aniao.backend.auth.UserPrincipal;
import com.aniao.backend.user.UserRepository;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
	private final AuthService auth;
	private final UserRepository users;

	public AuthController(AuthService auth, UserRepository users) {
		this.auth = auth;
		this.users = users;
	}

	@PostMapping("/register")
	@ResponseStatus(HttpStatus.CREATED)
	AuthService.AuthResponse register(@Valid @RequestBody AuthService.RegisterRequest request) {
		return auth.register(request);
	}

	@PostMapping("/login")
	AuthService.AuthResponse login(@Valid @RequestBody AuthService.LoginRequest request) {
		return auth.login(request);
	}

	@PostMapping("/password")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	void changePassword(
			@AuthenticationPrincipal UserPrincipal principal,
			@Valid @RequestBody AuthService.ChangePasswordRequest request) {
		var user = users.findById(principal.id())
				.orElseThrow(() -> new IllegalStateException("Authenticated user disappeared"));
		auth.changePassword(user, request);
	}
}
