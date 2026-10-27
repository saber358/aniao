package com.aniao.backend.web;

import com.aniao.backend.auth.UserPrincipal;
import com.aniao.backend.common.PageView;
import com.aniao.backend.usage.UsageService;
import com.aniao.backend.user.UserRepository;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;

@RestController
@RequestMapping("/api/usage")
public class UsageController {
	private final UsageService usage;
	private final UserRepository users;

	public UsageController(UsageService usage, UserRepository users) {
		this.usage = usage;
		this.users = users;
	}

	@PostMapping
	@ResponseStatus(HttpStatus.CREATED)
	UsageService.UsageView record(
			@AuthenticationPrincipal UserPrincipal principal,
			@Valid @RequestBody UsageService.UsageRequest request) {
		var user = users.findById(principal.id()).orElseThrow();
		return usage.record(user, request);
	}

	@GetMapping("/summary")
	UsageService.UsageSummary summary(
			@AuthenticationPrincipal UserPrincipal principal,
			@RequestParam(required = false) Instant from,
			@RequestParam(required = false) Instant to) {
		return usage.summary(principal.id(), from, to);
	}

	@GetMapping("/records")
	PageView<UsageService.UsageView> records(
			@AuthenticationPrincipal UserPrincipal principal,
			@RequestParam(required = false) Instant from,
			@RequestParam(required = false) Instant to,
			@RequestParam(defaultValue = "0") int page,
			@RequestParam(defaultValue = "30") int size) {
		return usage.records(principal.id(), from, to, page, size);
	}
}
