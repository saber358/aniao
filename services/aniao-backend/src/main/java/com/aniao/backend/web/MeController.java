package com.aniao.backend.web;

import com.aniao.backend.auth.UserPrincipal;
import com.aniao.backend.user.UserService;
import com.aniao.backend.user.UserView;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api")
public class MeController {
	private final UserService users;

	public MeController(UserService users) {
		this.users = users;
	}

	@GetMapping("/me")
	UserView me(@AuthenticationPrincipal UserPrincipal principal) {
		return users.me(principal.id());
	}
}
